import type { Register, Timer, ToolCallArgs, ToolCallResult, UiPane } from 'claude-code'

import * as Thread from './thread'
import { paneView } from './view'

export const COMMAND = 'crosstalk'
export const PANE_ID = 'crosstalk'

// How often the open pane asks ListAgents who is around.
export const REFRESH_MS = 15_000

const PEER_ORIGINS = { kind: ['peer', 'peer-send-message'] } as const

/**
 * The engine calls crosstalk needs after `session.start`, bound once there
 * so the pane's closures (a pick, a submit, a timer) can reach them.
 */
type Host = {
  now: () => Promise<number>
  every: (ms: number, fn: () => void) => Timer
  invalidate: () => void
  status: (text: string | undefined) => void
  open: () => Promise<void>
  close: () => Promise<void>
  panes: () => Promise<readonly UiPane[]>
  call: (args: ToolCallArgs) => Promise<ToolCallResult>
}

/**
 * Registers crosstalk: `/crosstalk` toggles a pane holding this session's
 * conversations with its peers. Incoming peer deliveries (`session.receive`)
 * and outgoing SendMessage calls (`tool.call`) are recorded as they pass;
 * neither is changed. A reply typed in the pane goes out as SendMessage.
 */
export const register: Register = on => {
  let thread: Thread.Thread = Thread.EMPTY
  let host: Host | undefined
  let isOpen = false
  let refresh: Timer | undefined
  // The reply the pane is sending: recorded by send() itself, since the
  // engine may or may not run this plugin's tool.call hook for its own call.
  let replying: string | undefined
  // What the person has typed in the reply field so far.
  let draft = ''

  function redraw(): void {
    const unread = Thread.unreadCount(thread)

    host?.invalidate()
    host?.status(unread > 0 && !isOpen ? `crosstalk · ${unread} unread` : undefined)
  }

  async function refreshPeers(): Promise<void> {
    const result = await host?.call({ tool: 'ListAgents' }).catch(() => undefined)
    const record: unknown = result?.result
    const listing = typeof record === 'object' && record ? Reflect.get(record, 'listing') : undefined

    if (typeof listing === 'string') {
      thread = Thread.withListing(thread, Thread.listingOf(listing))
      redraw()
    }
  }

  async function send(text: string): Promise<void> {
    const to = thread.selected
    const message = text.trim()

    if (!host || to === undefined || message === '') {
      return
    }

    replying = message

    const result = await host
      .call({ tool: 'SendMessage', to, message, summary: 'crosstalk reply' })
      .catch((error: unknown) => ({ deny: String(error), isError: undefined }))
      .finally(() => {
        replying = undefined
      })

    if (result.deny !== undefined) {
      host.status(`crosstalk · not sent: ${result.deny}`)

      return
    }

    if (result.isError !== true) {
      thread = Thread.record(thread, { dir: 'out', peer: to, text: message, at: await host.now() })
      redraw()
    }
  }

  on('session.start', async ($, e, next) => {
    host = {
      now: () => $.clock.now(),
      every: (ms, fn) => $.clock.every(ms, fn),
      invalidate: () => $.ui.invalidate('ui.render'),
      status: text => $.ui.status(text),
      open: () =>
        $.ui.open({
          id: PANE_ID,
          title: 'crosstalk',
          focus: true,
          closeOnEscape: true,
          rows: 20,
          columns: 64,
        }),
      close: () => $.ui.close({ id: PANE_ID }),
      panes: () => $.ui.panes(),
      call: args => $.tool.call(args),
    }

    await $.command.register({
      name: COMMAND,
      description: 'Chat with your other Claude Code sessions',
      immediate: true,
    })

    // A reload (a module edit, a worker respawn) finds its pane still up.
    if ((await host.panes()).some(pane => pane.id === PANE_ID)) {
      isOpen = true
      await refreshPeers()
      refresh ??= host.every(REFRESH_MS, () => void refreshPeers())
    }

    return next(e)
  })

  on('session.receive', { origin: PEER_ORIGINS }, async ($, e, next) => {
    const { peer, text } = Thread.inboundOf(e.text)

    thread = Thread.record(thread, { dir: 'in', peer, text, at: await $.clock.now() }, isOpen)
    redraw()

    return next(e)
  })

  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const result = await next(e)
    const isSent = result.deny === undefined && result.isError !== true && e.message !== replying

    if (isSent && e.tool === 'SendMessage' && typeof e.to === 'string' && typeof e.message === 'string') {
      thread = Thread.record(thread, {
        dir: 'out',
        peer: Thread.nameOf(e.to),
        text: e.message,
        at: await $.clock.now(),
      })
      redraw()
    }

    return result
  })

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    if (!host) {
      return next(e)
    }

    if (isOpen) {
      await host.close()

      return { text: 'crosstalk closed' }
    }

    await host.open()
    isOpen = true

    if (thread.selected !== undefined) {
      thread = Thread.select(thread, thread.selected)
    }

    await refreshPeers()
    refresh ??= host.every(REFRESH_MS, () => void refreshPeers())
    redraw()

    const pane = (await host.panes()).find(p => p.id === PANE_ID)

    return pane?.isPlaced === false
      ? { text: 'crosstalk is open: widen the terminal to 110 columns to see it' }
      : {}
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const result = await next(e)

    if (result.deny === undefined) {
      isOpen = false
      refresh?.cancel()
      refresh = undefined
      redraw()
    }

    return result
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID || (e.surface !== 'terminal' && e.surface !== 'desktop')) {
      return next(e)
    }

    const { Box, Text, Select, Input } = await $.ui.resolve(e)

    return paneView(
      {
        ui: { Box, Text, Select, Input },
        rows: e.props.scroll.bodyRows,
        onSelect: peer => {
          thread = Thread.select(thread, peer)
          redraw()
        },
        draft,
        onInput: text => {
          draft = text
          host?.invalidate()
        },
        onSubmit: text => {
          draft = ''
          void send(text)
        },
      },
      thread,
    )
  })
}
