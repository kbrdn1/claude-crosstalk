import type { EngineInterface, Register, Timer, ToolCallArgs, ToolCallResult, UiPane } from 'claude-code'

import * as Thread from './thread'
import { paneView } from './view'

export const COMMAND = 'crosstalk'
export const PANE_ID = 'crosstalk'

// How often the open pane asks ListAgents who is around.
export const REFRESH_MS = 15_000

const PEER_ORIGINS = { kind: ['peer', 'peer-send-message'] } as const

// One store key a session: `thread:<session id>`.
const STORE_PREFIX = 'thread:'

// ponytail: the 50 most recent sessions' threads stay in the store, the
// rest go at a start; a size cap if a session's thread grows past use.
export const MAX_SESSIONS = 50

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
  save: (value: Thread.Saved) => Promise<void>
  toast: (text: string) => void
}

/**
 * Why a SendMessage call did not reach anyone, or undefined when it did. A
 * recipient no session answers to is `{ success: false }`, not an error.
 */
function refusalOf(result: ToolCallResult): string | undefined {
  const record: unknown = result.result
  const field = (key: string) =>
    typeof record === 'object' && record !== null ? Reflect.get(record, key) : undefined

  if (result.deny !== undefined) {
    return result.deny
  }

  if (result.isError === true || field('success') === false) {
    const reason = field('display') ?? field('message') ?? result.text

    return typeof reason === 'string' ? reason : 'refused'
  }

  return undefined
}

/**
 * The lines of this session's journal worth parsing (Thread.fromJournal):
 * found by id under the config directory's projects/, filtered by grep so a
 * long journal is never read whole into the plugin.
 */
async function journalOf($: EngineInterface, id: string): Promise<string[]> {
  const config =
    (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  const found = await $.process.run([
    'find',
    `${config}/projects`,
    '-maxdepth',
    '2',
    '-name',
    `${id}.jsonl`,
  ])
  const file = found.stdout.split('\n').find(Boolean)

  if (file === undefined) {
    return []
  }

  const { stdout } = await $.process.run(['grep', '-E', Thread.JOURNAL_PATTERN, file])

  return stdout.split('\n').filter(Boolean)
}

/**
 * Drops the stored threads of all but the MAX_SESSIONS most recent sessions.
 */
async function prune($: EngineInterface): Promise<void> {
  const keys = (await $.store.keys()).filter(key => key.startsWith(STORE_PREFIX))

  if (keys.length <= MAX_SESSIONS) {
    return
  }

  const dated = await Promise.all(
    keys.map(async key => ({ key, at: Thread.savedAtOf(await $.store.get(key)) })),
  )
  const oldest = dated.sort((a, b) => a.at - b.at).slice(0, keys.length - MAX_SESSIONS)

  await Promise.all(oldest.map(({ key }) => $.store.delete(key)))
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

  /**
   * The thread with a new message in it: drawn, and saved for the next start.
   */
  async function commit(next: Thread.Thread): Promise<void> {
    thread = next
    redraw()
    await host
      ?.now()
      .then(now => host?.save(Thread.toSaved(thread, now)))
      .catch(() => undefined)
  }

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
      .call({ tool: 'SendMessage', to: Thread.addressOf(thread, to), message, summary: 'crosstalk reply' })
      .catch((error: unknown) => ({ deny: String(error), isError: undefined }))
      .finally(() => {
        replying = undefined
      })
    const refusal = refusalOf(result)

    if (refusal !== undefined) {
      host.toast(`crosstalk · not sent: ${refusal}`)

      return
    }

    await commit(Thread.record(thread, { dir: 'out', peer: to, text: message, at: await host.now() }))
  }

  on('session.start', async ($, e, next) => {
    const id = await $.session.id()
    const key = `${STORE_PREFIX}${id}`

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
      save: value => $.store.set(key, value),
      toast: text => $.ui.toast(text),
    }

    await $.command.register({
      name: COMMAND,
      description: 'Chat with your other Claude Code sessions',
      immediate: true,
    })

    // What this session said before this module ran: its stored thread
    // (a reload, a restart, a --resume), else, on its first start, what its
    // journal holds from before crosstalk was loaded.
    if (thread.entries.length === 0) {
      const saved = Thread.fromSaved(await $.store.get(key).catch(() => undefined))
      const history = saved ?? Thread.fromJournal(await journalOf($, id).catch(() => []))

      thread = Thread.withListing(history, thread)

      if (saved === undefined && history.entries.length > 0) {
        await commit(thread)
      }

      redraw()
    }

    await prune($).catch(() => undefined)

    // A reload (a module edit, a worker respawn) finds its pane still up.
    if ((await host.panes()).some(pane => pane.id === PANE_ID)) {
      isOpen = true
      await refreshPeers()
      refresh ??= host.every(REFRESH_MS, () => void refreshPeers())
    }

    return next(e)
  })

  on('session.receive', { origin: PEER_ORIGINS }, async ($, e, next) => {
    const { peer, text, address } = Thread.inboundOf(e.text)
    const known = Thread.withAlias(thread, address, peer)

    await commit(Thread.record(known, { dir: 'in', peer, text, at: await $.clock.now() }, isOpen))

    return next(e)
  })

  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const result = await next(e)
    const isSent = refusalOf(result) === undefined && e.message !== replying

    if (isSent && e.tool === 'SendMessage' && typeof e.to === 'string' && typeof e.message === 'string') {
      await commit(
        Thread.record(thread, {
          dir: 'out',
          peer: Thread.peerOf(thread, e.to),
          text: e.message,
          at: await $.clock.now(),
        }),
      )
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
