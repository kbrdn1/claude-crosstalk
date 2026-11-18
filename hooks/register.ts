import type {
  EngineInterface,
  FsEntry,
  FsStat,
  ProcessRunResult,
  Register,
  Timer,
  ToolCallArgs,
  ToolCallResult,
  UiOpenResult,
  UiPane,
} from 'claude-code'

import * as Thread from './thread'
import * as View from './view'

export const COMMAND = 'crosstalk'
export const PANE_ID = 'crosstalk'

// How often the open pane asks ListAgents who is around.
export const REFRESH_MS = 15_000

// How long after `/crosstalk` the pane asks for the keyboard again.
export const FOCUS_RETRY_MS = 150

// How long after a view switch the pane asks for the keyboard back: the keys
// have to have fallen back to the prompt, or the ask is refused.
export const REFOCUS_MS = 400

// How often, in Herdr, crosstalk looks whether Herdr's outbox changed.
export const OUTBOX_MS = 1_000

// A local session's delivery is `peer` (seen live on 2.1.312); 2.1.277 named
// another session's SendMessage `peer-send-message`. Two members of the
// origin union, which a kind array cannot span: one RegExp.
const PEER_ORIGINS = { kind: /^peer(-send-message)?$/ }

// An inbox row's key: the prefix, then the peer's name.
const ROW_PREFIX = 'open:'

// One store key a session: `thread:<session id>`.
const STORE_PREFIX = 'thread:'

// The titles the person gave, by key, shared by every session.
const TITLES_KEY = 'titles'

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
  after: (ms: number, fn: () => void) => Timer
  invalidate: () => void
  status: (text: string | undefined) => void
  open: () => Promise<UiOpenResult>
  close: () => Promise<void>
  focus: (key: string) => Promise<boolean>
  panes: () => Promise<readonly UiPane[]>
  call: (args: ToolCallArgs) => Promise<ToolCallResult>
  save: (value: Thread.Saved) => Promise<void>
  titles: () => Promise<unknown>
  saveTitles: (value: Record<string, string>) => Promise<void>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  stat: (path: string) => Promise<FsStat>
  list: (path: string) => Promise<FsEntry[]>
  run: (argv: readonly string[]) => Promise<ProcessRunResult>
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
 * Whether a SendMessage went to a teammate's mailbox, not to another session:
 * its result carries `routing` (seen live on 2.1.312; typed `unknown`).
 */
function isTeamSend(result: ToolCallResult): boolean {
  const record: unknown = result.result

  return typeof record === 'object' && record !== null && 'routing' in record
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
  // What the person has typed in each conversation's reply field so far.
  const drafts = new Map<string, string>()
  // The title being typed in rename mode: a redraw keeps it.
  let titleDraft = ''
  // How many messages the thread is scrolled back from its newest one.
  let back = 0
  // Why the last reply did not go, shown in the pane until the next one.
  let notice: string | undefined
  // The inbox, or the conversation opened from it.
  let view: 'inbox' | 'thread' = 'inbox'
  // In a conversation, vim's modes: typing a reply, or moving with keys.
  let mode: 'insert' | 'normal' | 'rename' = 'insert'
  // The key of our element holding the focus ring, as ui.focus last said.
  let ring: string | undefined
  // In Herdr: where this session publishes its conversations, and where
  // Herdr leaves what to send. Undefined outside it, where nothing is written.
  let herdr: { dir: string; file: string; outbox: string } | undefined
  // Herdr's folder, each file read as it stood (mtime and size): another
  // terminal's publication is read again only once it changed.
  const directory = new Map<string, { stamp: string; value: unknown }>()
  let sessionId = ''
  // This session as it publishes itself to Herdr: its id, terminal, folder
  // and project.
  let self: Thread.Self = { id: '' }
  // What was last published, its time left out: an unchanged view is not
  // written again. One write at a time, in order.
  let published = ''
  let publishing: Promise<void> = Promise.resolve()
  // The outbox's mtime and size when it was last read whole.
  let outboxSeen = ''
  let isPolling = false
  // The titles being stored, one change after the other.
  let titling: Promise<unknown> = Promise.resolve()
  // The timer looking at the outbox.
  let looking: Timer | undefined

  /**
   * Where the ring is decides the mode: on the reply field, typing; on any
   * other element of a conversation, moving.
   */
  function onRing(key: string | undefined): void {
    ring = key

    const now = key === 'reply' ? 'insert' : key === 'title' ? 'rename' : 'normal'

    if (view === 'thread' && key !== undefined && now !== mode) {
      mode = now
      host?.invalidate()
    }
  }

  /**
   * Moves the ring to `key`. Seen live: the engine raises no ui.focus to the
   * plugin for its own move, so the ring is noted here.
   */
  function focus(key: string): void {
    void host?.focus(key).then(isMoved => {
      if (isMoved) onRing(key)
    })
  }

  /**
   * Whether `peer`'s conversation is on screen: its messages arrive read.
   */
  function isReading(peer: string): boolean {
    return isOpen && view === 'thread' && thread.selected === peer
  }

  /**
   * Gives `key` the keyboard once the view that draws it is drawn. Seen live:
   * the element that held it (a row, ‹) is gone with the old view, and the
   * keys fall back to the prompt; the pane asks for them again, as on open.
   */
  function refocus(key: string): void {
    host?.after(REFOCUS_MS, () => {
      void host
        ?.open()
        .then(() => focus(key))
        .catch(() => undefined)
    })
  }

  /**
   * The inbox rows' keys, top to bottom.
   */
  function rowsOf(): string[] {
    return Thread.conversationsOf(thread).map(c => `${ROW_PREFIX}${c.peer}`)
  }

  /**
   * The element the ring starts on when the pane takes the keyboard: the
   * inbox row last opened, the reply field, or ‹ in normal mode.
   */
  function homeOf(): string {
    if (view === 'thread') {
      return mode === 'insert' ? 'reply' : mode === 'rename' ? 'title' : 'back'
    }

    const peers = Thread.conversationsOf(thread).map(c => c.peer)
    const peer = peers.includes(thread.selected ?? '') ? thread.selected : peers[0]

    return `open:${peer ?? ''}`
  }

  function openThread(peer: string): void {
    thread = Thread.select(thread, peer)
    view = 'thread'
    mode = 'insert'
    back = 0
    notice = undefined
    redraw()
    refocus('reply')
  }

  function openInbox(): void {
    const from = thread.selected

    view = 'inbox'
    back = 0
    redraw()
    refocus(from === undefined ? 'reply' : `open:${from}`)
  }

  /**
   * The thread with a new message in it: drawn, and saved for the next start.
   */
  async function commit(next: Thread.Thread): Promise<boolean> {
    thread = next
    redraw()

    const isSaved = await host
      ?.now()
      .then(now => host?.save(Thread.toSaved(thread, now)))
      .then(() => true)
      .catch(() => false)

    return isSaved === true
  }

  /**
   * Scrolls the selected thread `by` messages back (negative: forward),
   * within its messages.
   */
  function scrollBack(by: number): void {
    const count = Thread.messagesWith(thread, thread.selected).length

    back = Math.min(Math.max(0, back + by), Math.max(0, count - 1))
    host?.invalidate()
  }

  /**
   * Keeps the reader where they are when a message lands in the conversation
   * they have scrolled back in.
   */
  function holdPlace(peer: string): void {
    if (back > 0 && peer === thread.selected) {
      back += 1
    }
  }

  function redraw(): void {
    const unread = Thread.unreadCount(thread)

    host?.invalidate()
    host?.status(unread > 0 && !isOpen ? `crosstalk · ${unread} unread` : undefined)
    publish()
  }

  /**
   * Hands the thread to Herdr, when the session runs in it: written beside
   * the file, then moved over it, so Herdr never reads half of one. Each
   * write takes the thread as it stands when its turn comes.
   */
  function publish(): void {
    const via = host
    const target = herdr

    if (via === undefined || target === undefined) {
      return
    }

    publishing = publishing
      .then(async () => {
        const view = Thread.herdrOf(thread, self, await via.now())
        const body = JSON.stringify({ ...view, updatedAt: 0 })

        if (body === published) {
          return
        }

        await via.write(`${target.file}.tmp`, JSON.stringify(view))

        const moved = await via.run(['mv', '-f', `${target.file}.tmp`, target.file])

        // A failed move leaves the old file: the next change writes again.
        if (moved.exitCode === 0) {
          published = body
        }
      })
      .catch(() => undefined)
  }

  /**
   * The sessions the other Herdr terminals publish, each with its project
   * and its claude-flow topic. A name two files claim is the newest file's
   * (the other one's terminal is gone); this session's own file is skipped.
   */
  async function readDirectory(): Promise<Thread.Session[]> {
    const via = host
    const target = herdr

    if (via === undefined || target === undefined) {
      return []
    }

    const entries = await via.list(target.dir).catch(() => [])
    const stamps = new Map(entries.map(entry => [entry.name, `${entry.mtimeMs}:${entry.size}`]))
    const read = async <T>(name: string, parse: (text: string) => T): Promise<T | undefined> => {
      const stamp = stamps.get(name)
      const hit = directory.get(name)

      if (stamp === undefined) {
        return undefined
      }

      if (hit?.stamp === stamp) {
        return hit.value as T | undefined
      }

      const value = parse((await via.read(`${target.dir}/${name}`).catch(() => '')) ?? '')

      directory.set(name, { stamp, value })

      return value
    }
    const publications = entries
      .filter(entry => entry.name.endsWith('.crosstalk.json'))
      .filter(entry => `${target.dir}/${entry.name}` !== target.file)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
    const sessions = new Map<string, Thread.Session>()

    for (const entry of publications) {
      const published = await read(entry.name, Thread.sessionOf)

      if (published === undefined || published.id === sessionId || sessions.has(published.name)) {
        continue
      }

      const { id, name, project } = published
      // A v1 publication names no terminal: its file's name does.
      const terminal = published.terminal ?? entry.name.replace(/\.crosstalk\.json$/, '')
      const topic = await read(`${terminal}.flow.json`, Thread.topicOf)

      sessions.set(name, {
        id,
        name,
        ...(project === undefined ? {} : { project }),
        ...(topic === undefined ? {} : { topic }),
      })
    }

    for (const name of directory.keys()) {
      if (!stamps.has(name)) directory.delete(name)
    }

    return [...sessions.values()]
  }

  /**
   * Changes the shared titles by `changes` (key to title, an empty one
   * clears), over what the store holds now: another session's titles stay.
   */
  function storeTitles(changes: Readonly<Record<string, string>>): Promise<boolean> {
    // Nothing to change waits for nothing.
    if (Object.keys(changes).length === 0) {
      return Promise.resolve(true)
    }

    // One change at a time: two would each read the store, and the last to
    // write would undo the other.
    const run = titling.then(async () => {
      const via = host

      if (via === undefined) {
        return true
      }

      // Titles that could not be read are not written over: every
      // session's are in there.
      const read = await via.titles().then(
        value => ({ value }),
        () => undefined,
      )

      if (read === undefined) {
        return false
      }

      const stored = Thread.withTitles(Thread.EMPTY, read.value).titles
      const titles = Object.fromEntries(
        Object.entries({ ...stored, ...changes }).filter(([, title]) => title !== ''),
      )
      const isSaved = await via.saveTitles(titles).then(
        () => true,
        () => false,
      )

      if (isSaved) {
        thread = Thread.withTitles(thread, titles)
        redraw()
      }

      return isSaved
    })

    titling = run.catch(() => false)

    return run
  }

  /**
   * Every key the publication lists: each conversation's, each listed
   * session's.
   */
  function publishedKeys(): Set<string> {
    return new Set([
      ...Thread.conversationsOf(thread).map(c => c.peer),
      ...thread.peers.map(listed => Thread.keyOf(thread, listed.name)),
    ])
  }

  /**
   * What turns `before`'s titles into `after`'s: each key set or cleared.
   */
  function titleChanges(
    before: Readonly<Record<string, string>>,
    after: Readonly<Record<string, string>>,
  ): Record<string, string> {
    return Object.fromEntries([
      ...Object.keys(before)
        .filter(key => !Object.hasOwn(after, key))
        .map(key => [key, '']),
      ...Object.entries(after).filter(
        ([key, title]) => !Object.hasOwn(before, key) || before[key] !== title,
      ),
    ])
  }

  async function refreshPeers(): Promise<void> {
    const result = await host?.call({ tool: 'ListAgents' }).catch(() => undefined)
    const record: unknown = result?.result
    const listing =
      typeof record === 'object' && record ? Reflect.get(record, 'listing') : undefined

    if (typeof listing !== 'string' || host === undefined) {
      return
    }

    const at = await host.now()
    const sessions = herdr === undefined ? undefined : await readDirectory()
    // Titles another session gave since; unreadable, the ones known stay.
    const stored = await host.titles().catch(() => undefined)
    const merged = (base: Thread.Thread, titles: unknown) => {
      const withTitles = titles === undefined ? base : Thread.withTitles(base, titles)
      const listed = Thread.withListing(withTitles, Thread.listingOf(listing), at)

      return {
        listed,
        next: sessions === undefined ? listed : Thread.withDirectory(listed, sessions),
      }
    }
    const before = merged(thread, stored)
    const changes = titleChanges(before.listed.titles, before.next.titles)
    // A title that moved with its conversation moves in the store too.
    const isMoved = Object.keys(changes).length > 0 && (await storeTitles(changes))
    // The thread read after every wait: nothing that landed meanwhile is lost.
    const { listed, next } = merged(thread, isMoved ? undefined : stored)

    // The draft typed under a name follows its conversation to the id.
    for (const { id, name } of sessions ?? []) {
      const draft = drafts.get(name)

      if (draft !== undefined && Thread.keyOf(next, name) === id) {
        drafts.delete(name)

        if (!drafts.has(id)) drafts.set(id, draft)
      }
    }

    const listedNow = new Set(next.peers.map(peer => Thread.keyOf(next, peer.name)))
    const isGone = thread.peers.some(peer => !listedNow.has(Thread.keyOf(thread, peer.name)))

    if (next.entries !== listed.entries || isGone) {
      // A conversation moved to its session id, or a session left (when it
      // was last seen): kept for the next start.
      await commit(next)
    } else {
      thread = next
      redraw()
    }
  }

  /**
   * Sends `message` to `peer` through SendMessage and records it once it
   * went, with Herdr's outbox `id` when it came from there. Resolves why it
   * did not go, undefined when it did.
   */
  async function send(peer: string, message: string, id?: string): Promise<string | undefined> {
    if (!host) {
      return 'crosstalk is not started'
    }

    replying = message

    const result = await host
      .call({
        tool: 'SendMessage',
        to: Thread.addressOf(thread, peer),
        message,
        summary: 'crosstalk reply',
      })
      .catch((error: unknown) => ({ deny: String(error), isError: undefined }))
      .finally(() => {
        replying = undefined
      })
    const refusal = refusalOf(result)

    if (refusal !== undefined) {
      return refusal
    }

    const entry: Thread.Entry = { dir: 'out', peer, text: message, at: await host.now() }

    // The pane's own reply jumps to the newest message; Herdr's keeps the
    // reader where they are, as a message from the model does.
    if (id === undefined) {
      back = 0
    } else {
      holdPlace(peer)
    }

    await commit(Thread.record(thread, id === undefined ? entry : { ...entry, id }))

    return undefined
  }

  /**
   * The reply typed in the pane, to the conversation it shows.
   */
  async function reply(text: string): Promise<void> {
    const to = thread.selected
    const message = text.trim()

    if (to === undefined || message === '') {
      return
    }

    const refusal = await send(to, message)

    if (refusal !== undefined) {
      // The open pane holds toasts back: the reason goes in the pane.
      notice = `not sent: ${refusal}`
      host?.invalidate()
    }
  }

  /**
   * Answers one entry of Herdr's outbox, once per id: refused when it is for
   * no conversation of this session or says nothing, else saved as pending
   * (a reload then never sends it again) and sent as the pane's reply is.
   */
  async function deliver(
    { id, to, text }: Thread.Outgoing,
    listed: readonly string[],
  ): Promise<void> {
    if (!host || Object.hasOwn(thread.handled, id)) {
      return
    }

    const at = await host.now()
    const message = text.trim()
    // `to` is a key or a live name of a published peer.
    const keys = publishedKeys()
    const key = keys.has(to) ? to : Thread.keyOf(thread, to)
    const refusal = !keys.has(key)
      ? `unknown peer: ${to}`
      : message === ''
        ? 'empty message'
        : undefined
    const answer = (result: Thread.Handled) =>
      commit(Thread.withHandled(thread, id, result, listed))

    if (refusal !== undefined) {
      await answer({ status: 'refused', reason: refusal, at })

      return
    }

    // Unsaved, a reload would not know the id and would send it again.
    if (!(await answer({ status: 'pending', at }))) {
      await answer({ status: 'refused', reason: Thread.UNSAVED, at })

      return
    }

    const failure = await send(key, message, id)

    await answer(
      failure === undefined ? { status: 'sent', at } : { status: 'refused', reason: failure, at },
    )
  }

  /**
   * Reads Herdr's outbox when it changed since it was last read (its mtime
   * and size): marks what Herdr read, then answers its entries in order.
   */
  async function pollOutbox(): Promise<void> {
    const via = host
    const target = herdr

    if (via === undefined || target === undefined || isPolling) {
      return
    }

    isPolling = true

    try {
      const stat = await via.stat(target.outbox).catch(() => undefined)
      const seen = stat === undefined ? '' : `${stat.mtimeMs}:${stat.size}`

      if (seen === outboxSeen) {
        return
      }

      const text = stat === undefined ? undefined : await via.read(target.outbox).catch(() => '')
      const outbox = text === undefined ? undefined : Thread.outboxOf(text, sessionId)

      // A file caught mid-write is read again at the next look.
      outboxSeen = outbox === undefined ? '' : seen

      if (outbox === undefined) {
        return
      }

      const read = Object.entries(outbox.read).reduce(
        (next, [peer, at]) => Thread.readUpTo(next, Thread.keyOf(next, peer), at),
        thread,
      )

      if (read !== thread) {
        thread = read
        redraw()
      }

      // The titles Herdr gives, by key or live name of a published peer: each
      // once, when it appears or changes in the outbox (a rename made since,
      // here or elsewhere, stands). Not stored, the outbox is read again.
      const keys = publishedKeys()
      // An entry Herdr took out is forgotten: given again, it applies again.
      const kept = Object.fromEntries(
        Object.entries(thread.fromOutbox).filter(([raw]) => Object.hasOwn(outbox.title, raw)),
      )
      const fresh = Object.entries(outbox.title)
        .filter(([raw, title]) => !Object.hasOwn(kept, raw) || kept[raw] !== title)
        .filter(([raw]) => keys.has(Thread.keyOf(thread, raw)))
      const isTitled = await storeTitles(
        Object.fromEntries(fresh.map(([raw, title]) => [Thread.keyOf(thread, raw), title.trim()])),
      )
      const fromOutbox = { ...kept, ...Object.fromEntries(fresh) }

      if (!isTitled) {
        outboxSeen = ''
      } else if (JSON.stringify(fromOutbox) !== JSON.stringify(thread.fromOutbox)) {
        await commit({ ...thread, fromOutbox })
      }

      const listed = outbox.send.map(entry => entry.id)

      for (const entry of outbox.send) {
        await deliver(entry, listed)
      }
    } finally {
      isPolling = false
    }
  }

  on('session.start', async ($, e, next) => {
    const id = await $.session.id()
    const key = `${STORE_PREFIX}${id}`
    // Herdr names the terminal a session runs in; outside Herdr, no file. A
    // `claude -p` started from that terminal inherits the name: only the
    // interactive session there is the one Herdr shows.
    const terminal = await $.env.get('HC_TERMINAL_ID')
    const home = await $.env.get('HOME')
    const base = `${home ?? ''}/.claude/cache/herdr/${terminal ?? ''}`

    sessionId = id
    herdr =
      e.isInteractive && terminal && home
        ? {
            dir: `${home}/.claude/cache/herdr`,
            file: `${base}.crosstalk.json`,
            outbox: `${base}.crosstalk-outbox.json`,
          }
        : undefined

    if (herdr !== undefined && terminal) {
      // The main working tree's root names the project, a worktree's too.
      const root = (await $.session.repo().catch(() => null))?.root ?? e.cwd
      const project = root.split(/[\\/]/).findLast(Boolean)

      self = { id, terminal, cwd: e.cwd, ...(project === undefined ? {} : { project }) }
    }

    host = {
      now: () => $.clock.now(),
      every: (ms, fn) => $.clock.every(ms, fn),
      after: (ms, fn) => $.clock.after(ms, fn),
      invalidate: () => $.ui.invalidate('ui.render'),
      status: text => $.ui.status(text),
      open: () =>
        $.ui.open({
          id: PANE_ID,
          title: 'crosstalk',
          focus: true,
          closeOnEscape: true,
          holdToasts: true,
          rows: 20,
          columns: 64,
        }),
      close: () => $.ui.close({ id: PANE_ID }),
      focus: key =>
        $.ui.focus({ requestId: PANE_ID, key }).then(
          result => result.deny === undefined,
          () => false,
        ),
      panes: () => $.ui.panes(),
      call: args => $.tool.call(args),
      save: value => $.store.set(key, value),
      titles: () => $.store.get(TITLES_KEY),
      saveTitles: value => $.store.set(TITLES_KEY, value),
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      stat: path => $.fs.stat(path),
      list: path => $.fs.list(path),
      run: argv => $.process.run(argv),
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

    // The titles every session shares.
    const titles = await host.titles().catch(() => undefined)

    thread = Thread.withTitles(thread, titles)

    await prune($).catch(() => undefined)

    // A reload (a module edit, a worker respawn) finds its pane still up.
    if ((await host.panes()).some(pane => pane.id === PANE_ID)) {
      isOpen = true
    }

    // The open pane lists the peers; in Herdr they are listed all along, for
    // the session's name and its peers' status.
    if (isOpen || herdr !== undefined) {
      await refreshPeers()
      refresh ??= host.every(REFRESH_MS, () => void refreshPeers())
    }

    if (herdr !== undefined) {
      looking ??= host.every(OUTBOX_MS, () => void pollOutbox())
    }

    return next(e)
  })

  on('session.receive', { origin: PEER_ORIGINS }, async ($, e, next) => {
    // A teammate writes through the agent-team mailbox, and a delivery with
    // an agentId is for one of this session's agents: neither is a message
    // between this session's conversation and another session.
    if ('teammate' in e.origin || e.agentId !== undefined) {
      return next(e)
    }

    const { peer: name, text, address } = Thread.inboundOf(e.text)
    // The time first: the thread is read after it, so a Herdr send that
    // landed during the wait is not overwritten.
    const at = await $.clock.now()
    // Filed under the sender's session id when Herdr's directory knows it.
    const peer = Thread.senderOf(thread, name, address)
    const known = Thread.withAlias(thread, address, peer)
    // A session renamed at the same socket takes its title along: in the
    // store too, or the next read would put the old one back.
    const moved = titleChanges(thread.titles, known.titles)

    holdPlace(peer)
    await commit(Thread.record(known, { dir: 'in', peer, text, at }, isReading(peer)))
    await storeTitles(moved)

    return next(e)
  })

  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const result = await next(e)
    const isSent = refusalOf(result) === undefined && !isTeamSend(result) && e.message !== replying

    if (
      isSent &&
      e.tool === 'SendMessage' &&
      typeof e.to === 'string' &&
      typeof e.message === 'string'
    ) {
      // The time first, the thread after it (see session.receive).
      const at = await $.clock.now()
      const peer = Thread.peerOf(thread, e.to)

      holdPlace(peer)
      await commit(Thread.record(thread, { dir: 'out', peer, text: e.message, at }))
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

    const placed = await host.open()

    isOpen = true
    view = 'inbox'
    back = 0

    // Focus is granted over an empty composer only, and while this command
    // runs the composer still holds `/crosstalk`: ask again once it cleared.
    // Seen live: without this second open, the pane never takes the keys.
    host.after(FOCUS_RETRY_MS, () => void host?.open().catch(() => undefined))

    await refreshPeers()
    refresh ??= host.every(REFRESH_MS, () => void refreshPeers())
    redraw()

    return placed.isPlaced ? {} : { text: `crosstalk is open: ${placed.reason}` }
  })

  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    // The person's esc in a conversation leaves the reply field (or the title
    // being typed) for normal mode, then goes back to the inbox, as vim and a
    // messaging app would; /crosstalk and q (the plugin's close) still close.
    if (e.origin.kind === 'person' && view === 'thread') {
      if (mode === 'insert' || mode === 'rename') {
        mode = 'normal'
        host?.invalidate()
        refocus('back')

        return { deny: 'normal mode' }
      }

      openInbox()

      return { deny: 'back to the inbox' }
    }

    const result = await next(e)

    if (result.deny === undefined) {
      isOpen = false

      // In Herdr the peers are listed whether the pane is open or not.
      if (herdr === undefined) {
        refresh?.cancel()
        refresh = undefined
      }

      redraw()
    }

    return result
  })

  // The person's moves (Tab, arrows, a click) and the engine's (autoFocus).
  on('ui.focus', async ($, e, next) => {
    const result = await next(e)

    if (e.requestId === PANE_ID && result.deny === undefined) {
      onRing(e.element)
    }

    return result
  })

  // The wheel and the scroll keys move the thread, not the pane: the
  // header and the reply field stay put.
  on('ui.scroll', { requestId: PANE_ID }, ($, e, next) => {
    // The inbox scrolls as a pane does; a conversation moves its thread.
    if (e.origin.kind !== 'person' || view !== 'thread') {
      return next(e)
    }

    scrollBack(-Math.sign(e.by) * Math.max(1, Math.round(Math.abs(e.by) / 3)))

    return {}
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID || (e.surface !== 'terminal' && e.surface !== 'desktop')) {
      return next(e)
    }

    const { Box, Text, Button, Input, Markdown } = await $.ui.resolve(e)

    return View.paneView(
      {
        ui: { Box, Text, Button, Input, Markdown },
        // A column for the left margin, three for the pane's close mark.
        columns: Math.max(16, e.props.bodyColumns - 4),
        rows: e.props.scroll.bodyRows,
        isFocused: e.props.isFocused,
        back,
        draft: drafts.get(thread.selected ?? '') ?? '',
        view,
        mode,
        onOpen: peer => openThread(peer),
        onInbox: () => openInbox(),
        home: homeOf(),
        onMove: delta => {
          const row = View.rowAfter(rowsOf(), ring, delta)

          if (row !== undefined) focus(row)
        },
        onOpenHere: () => {
          const row = View.rowAfter(rowsOf(), ring, 0)

          if (row !== undefined) openThread(row.slice(ROW_PREFIX.length))
        },
        onTop: () => {
          const row = rowsOf()[0]

          if (row !== undefined) focus(row)
        },
        onInsert: () => {
          mode = 'insert'
          host?.invalidate()
          focus('reply')
        },
        onClose: () => void host?.close().catch(() => undefined),
        onBack: by => scrollBack(by),
        onInput: text => {
          drafts.set(thread.selected ?? '', text)
          host?.invalidate()
        },
        notice,
        onSubmit: text => {
          drafts.delete(thread.selected ?? '')
          notice = undefined
          void reply(text)
        },
        // The legend that held the keys goes with the mode: they are asked
        // back once the title field is drawn, as on a view switch.
        onRename: () => {
          const key = thread.selected ?? ''

          mode = 'rename'
          titleDraft = Object.hasOwn(thread.titles, key) ? (thread.titles[key] ?? '') : ''
          host?.invalidate()
          refocus('title')
        },
        titleDraft,
        onTitleInput: text => {
          titleDraft = text
          host?.invalidate()
        },
        onTitle: title => {
          const key = thread.selected

          mode = 'normal'
          titleDraft = ''
          host?.invalidate()
          refocus('back')

          if (key === undefined) {
            return
          }

          void storeTitles({ [key]: title.trim() }).then(isStored => {
            // The open pane holds toasts back: the reason goes in the pane.
            if (!isStored) {
              notice = 'title not kept: the store refused it'
              host?.invalidate()
            }
          })
        },
      },
      thread,
    )
  })
}
