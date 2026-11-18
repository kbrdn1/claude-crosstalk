/**
 * The conversation state crosstalk keeps for one session: every message it
 * saw go out (SendMessage) or come in (a peer delivery), the peers
 * ListAgents last reported, which conversation the pane shows, and how many
 * messages each peer sent that nobody has looked at yet. Pure: every
 * function returns a new Thread.
 */

export type Direction = 'in' | 'out'

export type Entry = {
  dir: Direction
  peer: string
  text: string
  // When it passed; absent where the source kept no time.
  at?: number
  // The id Herdr gave it in its outbox; absent for every other message.
  id?: string
}

export type Peer = {
  name: string
  kind: string
  status: string
}

export type Thread = {
  self?: string
  entries: readonly Entry[]
  peers: readonly Peer[]
  selected?: string
  unread: Readonly<Record<string, number>>
  // A peer's socket address (an envelope's `from`) to its name
  // (`from-name`): a model answers a peer at its address, the pane files the
  // answer under its name.
  aliases: Readonly<Record<string, string>>
  // What became of each Herdr outbox entry, by its id.
  handled: Readonly<Record<string, Handled>>
  // A listed session's live name to its session id, as Herdr's directory
  // last said: a conversation is filed by the id, which survives a restart.
  ids: Readonly<Record<string, string>>
  // What is known of the peer behind each key, for its title.
  known: Readonly<Record<string, Known>>
  // The titles the person gave, by key: the store's, shared by sessions.
  titles: Readonly<Record<string, string>>
  // When ListAgents last listed each key.
  seen: Readonly<Record<string, number>>
}

/**
 * What a key's peer was last known as: its live name, its project, and what
 * it works on (its claude-flow issue or branch).
 */
export type Known = { name?: string; project?: string; topic?: string }

/**
 * One session Herdr's directory names: another terminal's publication, its
 * project, and the topic its claude-flow file gives.
 */
export type Session = { id: string; name: string; project?: string; topic?: string }

/**
 * What became of one Herdr outbox entry: sent, refused and why, or pending
 * while its SendMessage runs (saved first, so a reload never sends it twice).
 */
export type Handled =
  | { status: 'sent'; at: number }
  | { status: 'refused'; reason: string; at: number }
  | { status: 'pending'; at: number }

export type Conversation = {
  peer: string
  title: string
  status?: string
  unread: number
  last?: Entry
}

/**
 * What `$.store` keeps of a session's thread.
 */
export type Saved = {
  savedAt: number
  entries: Entry[]
  selected?: string
  aliases: Record<string, string>
  handled?: Record<string, Handled>
  known?: Record<string, Known>
  seen?: Record<string, number>
}

export const EMPTY: Thread = {
  entries: [],
  peers: [],
  unread: {},
  aliases: {},
  handled: {},
  ids: {},
  known: {},
  titles: {},
  seen: {},
}

// A session's name is its folder's and two hex digits of its own.
const NAME_SUFFIX = /-[0-9a-f]{2}$/

// A Claude Code session id: a UUID. Anything else in Herdr's folder was
// written by hand (a test's fixture) and names no session.
const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

// ponytail: one flat cap for the whole session, per-peer caps if a chatty
// peer ends up pushing the others' history out.
export const MAX_ENTRIES = 200

export const UNKNOWN_PEER = 'unknown session'

// How many Herdr outbox ids are remembered: Herdr drops an entry once it is
// answered, so only a stale outbox could hold one older than these.
export const MAX_HANDLED = 200

// Why an outbox entry left pending by a reload is not sent again.
export const INTERRUPTED = 'interrupted by a reload before its result: it may have been sent'

// Why an outbox entry whose id could not be saved first is not sent.
export const UNSAVED = 'not sent: its id could not be saved first, so a reload could send it twice'

/**
 * The session journal lines worth parsing: a peer delivery (its `origin`),
 * a SendMessage call, and a tool result routed to a teammate's mailbox. A
 * grep pattern, so a long journal is never read whole.
 */
export const JOURNAL_PATTERN =
  '"origin":\\{"kind":"peer|"name":"SendMessage","input":|"routing":\\{'

// Global: only ever used through matchAll, which clones it. A module-level
// /g regex is stateful under .test() or .exec(): do not.
const WRAPPED = /<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/g

const ATTRIBUTE = /\b([a-z-]+)="([^"]*)"/g

const REF_SUFFIX = /\s*\[[0-9a-f]{4,}\]\s*$/i

const SELF_LINE = /^This session is (.+?) \[[0-9a-f]+\]/m

// `  name [ref]  ·  kind  ·  status  ·  started 7d ago`
const PEER_LINE = /^\s+(.+?) \[[0-9a-f]+\]\s+·\s+([^·]+?)\s+·\s+([^·]+?)\s*(?:·.*)?$/

type Inbound = { peer: string; text: string; address?: string }

/**
 * A peer's address as SendMessage or a listing writes it, without the
 * ` [ref]` suffix that only disambiguates two sessions of one name.
 */
export function nameOf(address: string): string {
  return address.replace(REF_SUFFIX, '').trim()
}

/**
 * Every peer message a text carries, in order (a delivery can batch
 * several): `<cross-session-message from="uds:…" from-name="api">`. Named
 * by `from-name` when there is one, since `from` is a socket address.
 */
function envelopesOf(text: string): Inbound[] {
  return [...text.matchAll(WRAPPED)].map(([, head, body]) => {
    const attributes = new Map(
      [...(head ?? '').matchAll(ATTRIBUTE)].map(([, key, value]) => [key, value ?? '']),
    )
    const address = attributes.get('from')
    const sender = attributes.get('from-name') || nameOf(address ?? '')
    const inbound = { peer: sender || UNKNOWN_PEER, text: (body ?? '').trim() }

    return address ? { ...inbound, address } : inbound
  })
}

/**
 * Who sent a delivery, from where, and what it says; the whole text under
 * UNKNOWN_PEER when it has no envelope.
 */
export function inboundOf(text: string): Inbound {
  return envelopesOf(text)[0] ?? { peer: UNKNOWN_PEER, text: text.trim() }
}

/**
 * The key a live session name files its conversation under: the session id
 * Herdr's directory gives it, else the name itself.
 */
export function keyOf(thread: Thread, name: string): string {
  return Object.hasOwn(thread.ids, name) ? (thread.ids[name] ?? name) : name
}

/**
 * The key a delivery from `name`, at socket `address`, files under: the
 * session id its name resolves to; else, when its socket was last known
 * as a session id, that id (the directory may not have been read yet, and
 * a key goes from a name to an id, never back); else the name.
 */
export function senderOf(thread: Thread, name: string, address: string | undefined): string {
  const key = keyOf(thread, name)
  const aliased =
    address !== undefined && Object.hasOwn(thread.aliases, address)
      ? thread.aliases[address]
      : undefined
  const isSession =
    aliased !== undefined && aliased !== name && Object.hasOwn(thread.known, aliased)

  return key === name && isSession ? aliased : key
}

/**
 * The conversation a SendMessage `to` belongs to: the key behind a socket
 * address a peer wrote from, else the key of the address without its ref.
 */
export function peerOf(thread: Thread, to: string): string {
  return Object.hasOwn(thread.aliases, to) ? (thread.aliases[to] ?? to) : keyOf(thread, nameOf(to))
}

/**
 * The thread knowing that `address` is `peer`. A session renamed since it
 * last wrote from that address takes its conversation along.
 */
export function withAlias(thread: Thread, address: string | undefined, peer: string): Thread {
  const before = address === undefined ? undefined : thread.aliases[address]

  if (address === undefined || address === peer || before === peer) {
    return thread
  }

  const known = { ...thread, aliases: { ...thread.aliases, [address]: peer } }

  return before === undefined ? known : renamed(known, before, peer)
}

/**
 * `record` without `key`, and its value under `key`.
 */
function without<V>(record: Readonly<Record<string, V>>, key: string): [Record<string, V>, V?] {
  const { [key]: value, ...rest } = record

  return Object.hasOwn(record, key) ? [rest, value] : [{ ...record }]
}

/**
 * The thread with everything filed under `from` moved to `to`: messages,
 * unread (added up), the selection, socket aliases, the title (`to`'s own
 * wins), when it was seen (the latest) and what is known of it.
 */
function renamed(thread: Thread, from: string, to: string): Thread {
  const [unread, count = 0] = without(thread.unread, from)
  const [titles, title] = without(thread.titles, from)
  const [seen, at] = without(thread.seen, from)
  const [known, was] = without(thread.known, from)

  return {
    ...thread,
    entries: thread.entries.map(entry => (entry.peer === from ? { ...entry, peer: to } : entry)),
    unread: count > 0 ? { ...unread, [to]: unreadOf(thread, to) + count } : unread,
    selected: thread.selected === from ? to : thread.selected,
    aliases: Object.fromEntries(
      Object.entries(thread.aliases).map(([address, name]) => [address, name === from ? to : name]),
    ),
    titles: title === undefined || Object.hasOwn(titles, to) ? titles : { ...titles, [to]: title },
    seen: at === undefined ? seen : { ...seen, [to]: Math.max(at, seen[to] ?? 0) },
    known: was === undefined ? known : { ...known, [to]: { ...was, ...knownOf(thread, to) } },
  }
}

/**
 * What is known of `key`'s peer: its own entry only, since a key may be
 * named `constructor`.
 */
function knownOf(thread: Thread, key: string): Known {
  return Object.hasOwn(thread.known, key) ? (thread.known[key] ?? {}) : {}
}

/**
 * The name `key`'s session goes by in the current listing, if listed.
 */
function liveNameOf(thread: Thread, key: string): string | undefined {
  return thread.peers.find(listed => keyOf(thread, listed.name) === key)?.name
}

/**
 * Where a reply to `key` goes: its live name while ListAgents lists it, else
 * the socket it last wrote from (it outlives a rename, not a restart), else
 * the name it was last known by.
 */
export function addressOf(thread: Thread, key: string): string {
  return (
    liveNameOf(thread, key) ??
    Object.entries(thread.aliases).findLast(([, peer]) => peer === key)?.[0] ??
    knownOf(thread, key).name ??
    key
  )
}

/**
 * The peer sessions and this session's own name, read from ListAgents'
 * text. Only the `Peer sessions` section: subagents are this session's own.
 *
 * ponytail: parses the tool's human-readable listing, the only one it has;
 * swap for a structured source once the engine offers one to plugins.
 */
export function listingOf(text: string): { self?: string; peers: Peer[] } {
  const self = SELF_LINE.exec(text)?.[1]
  const peers: Peer[] = []
  let isPeerSection = false

  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) {
      isPeerSection = line.startsWith('Peer sessions')
      continue
    }

    const match = isPeerSection ? PEER_LINE.exec(line) : null

    if (match) {
      peers.push({
        name: (match[1] ?? '').trim(),
        kind: (match[2] ?? '').trim(),
        status: (match[3] ?? '').trim(),
      })
    }
  }

  return self === undefined ? { peers } : { self, peers }
}

/**
 * How many of `peer`'s messages wait unread: its own count only, since a
 * peer may be named `constructor` or `toString`.
 */
function unreadOf(thread: Thread, peer: string): number {
  return Object.hasOwn(thread.unread, peer) ? (thread.unread[peer] ?? 0) : 0
}

/**
 * The thread with one more message. An incoming one counts as unread unless
 * its conversation is on screen; the first message selects its conversation.
 */
export function record(thread: Thread, entry: Entry, isShown = false): Thread {
  const selected = thread.selected ?? entry.peer
  const isSeen = entry.dir === 'out' || (isShown && selected === entry.peer)

  return {
    ...thread,
    selected,
    entries: [...thread.entries, entry].slice(-MAX_ENTRIES),
    unread: isSeen
      ? thread.unread
      : { ...thread.unread, [entry.peer]: unreadOf(thread, entry.peer) + 1 },
  }
}

/**
 * The thread showing `peer`'s conversation, its messages now read.
 */
export function select(thread: Thread, peer: string): Thread {
  const { [peer]: _read, ...unread } = thread.unread

  return { ...thread, selected: peer, unread }
}

/**
 * The thread with the peers a fresh listing reported, each seen at `at`
 * when given.
 */
export function withListing(
  thread: Thread,
  listing: { self?: string; peers: readonly Peer[] },
  at?: number,
): Thread {
  const self = listing.self ?? thread.self
  const seen =
    at === undefined
      ? thread.seen
      : {
          ...thread.seen,
          ...Object.fromEntries(listing.peers.map(peer => [keyOf(thread, peer.name), at])),
        }
  const listed = { ...thread, peers: listing.peers, seen }

  return self === undefined ? listed : { ...listed, self }
}

/**
 * The thread knowing which session each listed name is, from Herdr's
 * directory: the map is rebuilt from the sessions listed now (not this one),
 * so a name a restart handed to another session moves on with it. A
 * conversation filed under such a name moves to the session id.
 */
export function withDirectory(thread: Thread, sessions: readonly Session[]): Thread {
  const listed = new Set(thread.peers.map(peer => peer.name))
  const named = sessions.filter(
    session =>
      listed.has(session.name) && session.name !== thread.self && session.name !== session.id,
  )
  let next: Thread = {
    ...thread,
    ids: Object.fromEntries(named.map(session => [session.name, session.id])),
    known: {
      ...thread.known,
      ...Object.fromEntries(
        named.map(({ id, name, project, topic }) => [
          id,
          {
            name,
            ...(project === undefined ? {} : { project }),
            ...(topic === undefined ? {} : { topic }),
          },
        ]),
      ),
    },
  }

  for (const { id, name } of named) {
    if (isFiled(next, name)) {
      next = renamed(next, name, id)
    }
  }

  return next
}

/**
 * Whether anything is filed under `key`.
 */
function isFiled(thread: Thread, key: string): boolean {
  return (
    thread.selected === key ||
    thread.entries.some(entry => entry.peer === key) ||
    Object.values(thread.aliases).includes(key) ||
    [thread.unread, thread.titles, thread.seen, thread.known].some(record =>
      Object.hasOwn(record, key),
    )
  )
}

/**
 * What another terminal's publication says of its session: id, live name,
 * terminal, project. Undefined without a name to map, with an id that is no
 * session id (a hand-written file), or for a file caught mid-write.
 */
export function sessionOf(
  text: string,
): { id: string; name: string; terminal?: string; project?: string } | undefined {
  let value: unknown

  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }

  const session = isRecord(value) && isRecord(value.session) ? value.session : {}
  const { id, name, terminal, project } = session

  if (typeof id !== 'string' || typeof name !== 'string' || !SESSION_ID.test(id) || name === '') {
    return undefined
  }

  return {
    id,
    name,
    ...(typeof terminal === 'string' ? { terminal } : {}),
    ...(typeof project === 'string' ? { project } : {}),
  }
}

/**
 * What a terminal's claude-flow file says it works on: its issue (`#61`),
 * else its branch.
 */
export function topicOf(text: string): string | undefined {
  let value: unknown

  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }

  const steps = isRecord(value) && Array.isArray(value.steps) ? value.steps.filter(isRecord) : []
  const labelOf = (id: string) => {
    const label = steps.find(step => step.id === id)?.label

    // A step not filled in yet is its bare id: it says nothing.
    const detail = typeof label === 'string' ? new RegExp(`^${id}\\s+(.+)$`).exec(label) : null

    return detail?.[1]?.trim() || undefined
  }

  return labelOf('issue') ?? labelOf('branch')
}

/**
 * The thread with `title` given to `key`; an empty one clears it.
 */
export function withTitle(thread: Thread, key: string, title: string): Thread {
  const [titles] = without(thread.titles, key)
  const given = title.trim()

  return { ...thread, titles: given === '' ? titles : { ...titles, [key]: given } }
}

/**
 * The thread with the titles the store holds.
 */
export function withTitles(thread: Thread, value: unknown): Thread {
  const titles = Object.fromEntries(
    Object.entries(isRecord(value) ? value : {}).filter(
      (pair): pair is [string, string] => typeof pair[1] === 'string' && pair[1] !== '',
    ),
  )

  return { ...thread, titles }
}

/**
 * The name a key's peer goes by: listed now, else as last known, else the
 * key itself.
 */
function nameOfKey(thread: Thread, key: string): string {
  return liveNameOf(thread, key) ?? knownOf(thread, key).name ?? key
}

/**
 * A key's project: the one its publication gives, else its name without the
 * random suffix a session's name carries; none for a name without one (a
 * Remote Control or cloud session's).
 */
function projectOf(thread: Thread, key: string, name: string): string | undefined {
  return (
    knownOf(thread, key).project ??
    (NAME_SUFFIX.test(name) ? name.replace(NAME_SUFFIX, '') : undefined)
  )
}

/**
 * Each key's title: the one the person gave, else `project · topic`, else
 * the project, else the name. Two keys whose project is all they have are
 * told apart by their session id's first characters, or else by their names.
 */
export function titlesOf(thread: Thread, keys: readonly string[]): Record<string, string> {
  const derived = keys.map(key => {
    const name = nameOfKey(thread, key)
    const base = projectOf(thread, key, name) ?? name
    const { topic } = knownOf(thread, key)

    return { key, name, title: topic === undefined ? base : `${base} · ${topic}` }
  })
  const counts = new Map<string, number>()

  for (const { key, title } of derived) {
    if (!Object.hasOwn(thread.titles, key)) counts.set(title, (counts.get(title) ?? 0) + 1)
  }

  return Object.fromEntries(
    derived.map(({ key, name, title }) => {
      const isSession = Object.hasOwn(thread.known, key) && key !== name
      const twin = (counts.get(title) ?? 0) > 1
      const told = !twin ? title : isSession ? `${title} · ${key.slice(0, 4)}` : name

      return [key, Object.hasOwn(thread.titles, key) ? (thread.titles[key] ?? told) : told]
    }),
  )
}

const KINDS: Readonly<Record<string, string>> = {
  'Remote Control': 'remote',
  bg: 'background',
}

/**
 * A ListAgents kind as Herdr reads it: `interactive`, `remote`, `cloud`,
 * `background`.
 */
export function kindOf(kind: string): string {
  return KINDS[kind] ?? kind.toLowerCase()
}

/**
 * Every conversation worth a row: each peer a message went to or came from,
 * then each local session ListAgents lists that nobody talked to yet. Most
 * recent first, a message without a time counting as the oldest.
 */
export function conversationsOf(thread: Thread): Conversation[] {
  const byPeer = new Map<string, Omit<Conversation, 'title'>>()
  const statusOf = new Map(thread.peers.map(peer => [keyOf(thread, peer.name), peer.status]))

  for (const entry of thread.entries) {
    byPeer.set(entry.peer, {
      peer: entry.peer,
      status: statusOf.get(entry.peer),
      unread: unreadOf(thread, entry.peer),
      last: entry,
    })
  }

  const active = [...byPeer.values()].sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0))
  const idle = thread.peers
    .filter(peer => peer.kind === 'interactive' && !byPeer.has(keyOf(thread, peer.name)))
    .map(peer => ({ peer: keyOf(thread, peer.name), status: peer.status, unread: 0 }))
  const rows = [...active, ...idle]
  const titles = titlesOf(
    thread,
    keysOf(
      thread,
      rows.map(row => row.peer),
    ),
  )

  return rows.map(row => ({ ...row, title: titles[row.peer] ?? row.peer }))
}

/**
 * The messages exchanged with `peer`, oldest first.
 */
export function messagesWith(thread: Thread, peer: string | undefined): Entry[] {
  return peer === undefined ? [] : thread.entries.filter(entry => entry.peer === peer)
}

/**
 * How many messages wait unread, all conversations together.
 */
export function unreadCount(thread: Thread): number {
  return Object.values(thread.unread).reduce((sum, count) => sum + count, 0)
}

/**
 * What to keep in `$.store`.
 */
export function toSaved(thread: Thread, now: number): Saved {
  const saved = {
    savedAt: now,
    entries: [...thread.entries],
    aliases: { ...thread.aliases },
    handled: { ...thread.handled },
    known: { ...thread.known },
    seen: { ...thread.seen },
  }

  return thread.selected === undefined ? saved : { ...saved, selected: thread.selected }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEntry(value: unknown): value is Entry {
  return (
    isRecord(value) &&
    (value.dir === 'in' || value.dir === 'out') &&
    typeof value.peer === 'string' &&
    typeof value.text === 'string' &&
    (value.at === undefined || typeof value.at === 'number') &&
    (value.id === undefined || typeof value.id === 'string')
  )
}

/**
 * A saved outbox result. A pending one is as the reload left it: sent when
 * its message made it into the thread (`isRecorded`), else refused, never
 * sent again.
 */
function handledOf(value: unknown, isRecorded: boolean): Handled | undefined {
  if (!isRecord(value) || typeof value.at !== 'number') {
    return undefined
  }

  if (value.status === 'sent' || (value.status === 'pending' && isRecorded)) {
    return { status: 'sent', at: value.at }
  }

  if (value.status === 'pending') {
    return { status: 'refused', reason: INTERRUPTED, at: value.at }
  }

  return value.status === 'refused' && typeof value.reason === 'string'
    ? { status: 'refused', reason: value.reason, at: value.at }
    : undefined
}

/**
 * The thread `$.store` kept, or undefined when the value is not one.
 */
export function fromSaved(value: unknown): Thread | undefined {
  if (!isRecord(value) || !Array.isArray(value.entries) || !isRecord(value.aliases)) {
    return undefined
  }

  const aliases = Object.fromEntries(
    Object.entries(value.aliases).filter(
      (pair): pair is [string, string] => typeof pair[1] === 'string',
    ),
  )
  const entries = value.entries.filter(isEntry)
  const recorded = new Set(entries.map(entry => entry.id))
  const handled = Object.fromEntries(
    Object.entries(isRecord(value.handled) ? value.handled : {}).flatMap(([id, result]) => {
      const known = handledOf(result, recorded.has(id))

      return known === undefined ? [] : [[id, known]]
    }),
  )
  const text = (record: Record<string, unknown>, key: string) =>
    typeof record[key] === 'string' ? { [key]: record[key] } : {}
  const known = Object.fromEntries(
    Object.entries(isRecord(value.known) ? value.known : {}).flatMap(([key, peer]) =>
      isRecord(peer)
        ? [[key, { ...text(peer, 'name'), ...text(peer, 'project'), ...text(peer, 'topic') }]]
        : [],
    ),
  )
  const seen = Object.fromEntries(
    Object.entries(isRecord(value.seen) ? value.seen : {}).filter(
      (pair): pair is [string, number] => typeof pair[1] === 'number',
    ),
  )
  const thread = { ...EMPTY, entries, aliases, handled, known, seen }

  return typeof value.selected === 'string' ? { ...thread, selected: value.selected } : thread
}

/**
 * When a stored thread was saved, 0 when the value is not one.
 */
export function savedAtOf(value: unknown): number {
  return isRecord(value) && typeof value.savedAt === 'number' ? value.savedAt : 0
}

/**
 * The tool_use ids a journal row answers with a result routed to a teammate's
 * mailbox (its `toolUseResult.routing`).
 */
function teammateSendsOf(row: Record<string, unknown>): string[] {
  const result = isRecord(row.toolUseResult) ? row.toolUseResult : {}
  const message = isRecord(row.message) ? row.message : {}

  if (!isRecord(result.routing) || !Array.isArray(message.content)) {
    return []
  }

  return message.content.flatMap(block =>
    isRecord(block) && typeof block.tool_use_id === 'string' ? [block.tool_use_id] : [],
  )
}

/**
 * The thread a session journal already holds, every message read: peer
 * deliveries (a `user` row or a `queued_command` attachment carrying an
 * `origin` of kind peer*, one per `msg_id`) and the model's SendMessage
 * calls, in order, with their times.
 *
 * ponytail: reads Claude Code's own session journal, an undocumented format
 * the plugin API does not expose (it hides peer rows from
 * `$.session.messages()`); a format change empties the rebuilt history, it
 * breaks nothing else. A refused SendMessage still shows as sent.
 */
export function fromJournal(lines: readonly string[]): Thread {
  const seen = new Set<string>()
  const rows = lines.flatMap(line => {
    try {
      const row: unknown = JSON.parse(line)

      return isRecord(row) ? [row] : []
    } catch {
      return []
    }
  })
  // A send whose result came back routed went to a teammate (2.1.312).
  const toTeammates = new Set(rows.flatMap(teammateSendsOf))
  let thread = EMPTY

  for (const row of rows) {
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
    const time = Number.isNaN(at) ? {} : { at }
    const attachment = isRecord(row.attachment) ? row.attachment : {}
    const origin = isRecord(row.origin)
      ? row.origin
      : isRecord(attachment.origin)
        ? attachment.origin
        : {}
    const message = isRecord(row.message) ? row.message : {}

    if (typeof origin.kind === 'string' && origin.kind.startsWith('peer')) {
      const id = typeof origin.msg_id === 'string' ? origin.msg_id : undefined

      if (id !== undefined && seen.has(id)) {
        continue
      }

      if (id !== undefined) {
        seen.add(id)
      }

      const framed = [message.content, attachment.prompt].find(t => typeof t === 'string')
      const envelope = typeof framed === 'string' ? envelopesOf(framed)[0] : undefined
      const address = typeof origin.from === 'string' ? origin.from : envelope?.address
      const peer =
        (typeof origin.name === 'string' && origin.name) ||
        envelope?.peer ||
        nameOf(address ?? '') ||
        UNKNOWN_PEER
      const text = (typeof origin.body === 'string' ? origin.body : (envelope?.text ?? '')).trim()

      thread = record(withAlias(thread, address, peer), { dir: 'in', peer, text, ...time })
      continue
    }

    if (row.type === 'assistant' && Array.isArray(message.content)) {
      for (const block of message.content) {
        const input = isRecord(block) && isRecord(block.input) ? block.input : {}
        const isSend =
          isRecord(block) &&
          block.type === 'tool_use' &&
          block.name === 'SendMessage' &&
          !toTeammates.has(String(block.id)) &&
          typeof input.to === 'string' &&
          typeof input.message === 'string'

        if (isSend) {
          const peer = peerOf(thread, String(input.to))

          thread = record(thread, { dir: 'out', peer, text: String(input.message), ...time })
        }
      }
    }
  }

  const selected = thread.entries.at(-1)?.peer

  return selected === undefined ? thread : { ...thread, unread: {}, selected }
}

/**
 * The thread with what became of Herdr's outbox entry `id`. Past MAX_HANDLED
 * ids, the oldest go, but never one the outbox still lists (`listed`): it
 * would be sent again.
 */
export function withHandled(
  thread: Thread,
  id: string,
  result: Handled,
  listed: readonly string[] = [],
): Thread {
  const { [id]: _before, ...rest } = thread.handled
  const kept = new Set(listed)
  let over = Object.keys(rest).length + 1 - MAX_HANDLED
  const entries = Object.entries(rest).filter(([key]) => {
    const isDropped = over > 0 && !kept.has(key)

    over -= isDropped ? 1 : 0

    return !isDropped
  })

  return { ...thread, handled: Object.fromEntries([...entries, [id, result]]) }
}

/**
 * The thread with `peer`'s messages up to `at` read: only those that came in
 * after it stay unread, never more than before.
 */
export function readUpTo(thread: Thread, peer: string, at: number): Thread {
  const after = thread.entries.filter(
    entry => entry.peer === peer && entry.dir === 'in' && (entry.at ?? 0) > at,
  ).length
  const { [peer]: _count, ...unread } = thread.unread
  const count = unreadOf(thread, peer)
  const left = Math.min(count, after)

  return left === count
    ? thread
    : { ...thread, unread: left > 0 ? { ...unread, [peer]: left } : unread }
}

/**
 * One message as Herdr reads it.
 */
export type HerdrMessage = { dir: Direction; text: string; at?: number; id?: string }

/**
 * One peer as Herdr reads it: its stable key, what to call it, where it
 * stands, and its conversation's state.
 */
export type HerdrPeer = {
  key: string
  sessionId?: string
  title: string
  name: string
  address: string
  project?: string
  topic?: string
  kind?: string
  status?: string
  live: boolean
  lastSeenAt?: number
  lastMessageAt?: number
  unread: number
  last?: HerdrMessage
}

/**
 * This session as it publishes itself: its id, and where it runs.
 */
export type Self = { id: string; terminal?: string; cwd?: string; project?: string }

/**
 * What crosstalk publishes for Herdr: the contract of the README's Herdr
 * section, version `v`.
 */
export type Publication = {
  v: 2
  session: Self & { name?: string }
  updatedAt: number
  peers: HerdrPeer[]
  threads: Record<string, HerdrMessage[]>
  handled: Record<string, Handled>
}

function herdrMessageOf({ dir, text, at, id }: Entry): HerdrMessage {
  return { dir, text, ...(at === undefined ? {} : { at }), ...(id === undefined ? {} : { id }) }
}

/**
 * Every key worth a title, so twins are told apart the same way everywhere:
 * each conversation's and each listed session's.
 */
function keysOf(thread: Thread, first: readonly string[]): string[] {
  return [...new Set([...first, ...thread.peers.map(peer => keyOf(thread, peer.name))])]
}

/**
 * The publication for session `self`: every conversation as the inbox orders
 * it then every other listed session, each one's messages oldest first, and
 * each outbox entry's result (a pending one is not one yet).
 */
export function herdrOf(thread: Thread, self: Self, updatedAt: number): Publication {
  // A Map, not an object: a peer may be named `constructor` or `__proto__`.
  const threads = new Map<string, HerdrMessage[]>()

  for (const entry of thread.entries) {
    threads.set(entry.peer, [...(threads.get(entry.peer) ?? []), herdrMessageOf(entry)])
  }

  const conversations = new Map(conversationsOf(thread).map(c => [c.peer, c]))
  const keys = keysOf(thread, [...conversations.keys()])
  const titles = titlesOf(thread, keys)
  const peers = keys.map((key): HerdrPeer => {
    const { unread = 0, last } = conversations.get(key) ?? {}
    const listed = thread.peers.find(peer => keyOf(thread, peer.name) === key)
    const name = nameOfKey(thread, key)
    const project = projectOf(thread, key, name)
    const { topic } = knownOf(thread, key)
    const seen = Object.hasOwn(thread.seen, key) ? thread.seen[key] : undefined
    const isSession = Object.hasOwn(thread.known, key) && key !== name

    return {
      key,
      ...(isSession ? { sessionId: key } : {}),
      title: titles[key] ?? name,
      name,
      address: addressOf(thread, key),
      ...(project === undefined ? {} : { project }),
      ...(topic === undefined ? {} : { topic }),
      ...(listed === undefined ? {} : { kind: kindOf(listed.kind), status: listed.status }),
      live: listed !== undefined,
      // A listed session is seen now: its time would rewrite the file at
      // every listing for nothing.
      ...(seen === undefined || listed !== undefined ? {} : { lastSeenAt: seen }),
      ...(last?.at === undefined ? {} : { lastMessageAt: last.at }),
      unread,
      ...(last === undefined ? {} : { last: { ...herdrMessageOf(last), id: undefined } }),
    }
  })

  return {
    v: 2,
    session: thread.self === undefined ? self : { ...self, name: thread.self },
    updatedAt,
    peers,
    threads: Object.fromEntries(threads),
    handled: Object.fromEntries(
      Object.entries(thread.handled).filter(([, result]) => result.status !== 'pending'),
    ),
  }
}

/**
 * One message Herdr asks to send: `to` a conversation's key or name.
 */
export type Outgoing = { id: string; to: string; text: string }

/**
 * What Herdr's outbox asks: messages to send, each conversation read up to a
 * time, and titles to give (an empty one clears).
 */
export type Outbox = {
  send: Outgoing[]
  read: Record<string, number>
  title: Record<string, string>
}

/**
 * What Herdr's outbox asks of session `session`, or undefined when its text
 * is no JSON (a file caught mid-write). An outbox of another version, or
 * written for another session of the terminal, asks nothing. An entry
 * without an id has nothing to be answered by and is left out; a `to` or a
 * text of the wrong type is empty, which the send refuses.
 */
export function outboxOf(text: string, session: string): Outbox | undefined {
  let value: unknown

  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }

  const record = isRecord(value) ? value : {}

  const isVersion = record.v === 1 || record.v === 2

  if (!isVersion || (record.session !== undefined && record.session !== session)) {
    return { send: [], read: {}, title: {} }
  }

  const send = (Array.isArray(record.send) ? record.send : []).flatMap(entry =>
    isRecord(entry) && typeof entry.id === 'string' && entry.id !== ''
      ? [
          {
            id: entry.id,
            to: typeof entry.to === 'string' ? entry.to : '',
            text: typeof entry.text === 'string' ? entry.text : '',
          },
        ]
      : [],
  )
  const read = Object.fromEntries(
    Object.entries(isRecord(record.read) ? record.read : {}).filter(
      (pair): pair is [string, number] => typeof pair[1] === 'number',
    ),
  )
  const title = Object.fromEntries(
    Object.entries(isRecord(record.title) ? record.title : {}).filter(
      (pair): pair is [string, string] => typeof pair[1] === 'string',
    ),
  )

  return { send, read, title }
}
