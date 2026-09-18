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
  at: number
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
}

export type Conversation = {
  peer: string
  status?: string
  unread: number
  last?: Entry
}

export const EMPTY: Thread = { entries: [], peers: [], unread: {} }

// ponytail: one flat cap for the whole session, per-peer caps if a chatty
// peer ends up pushing the others' history out.
export const MAX_ENTRIES = 200

export const UNKNOWN_PEER = 'unknown session'

const WRAPPED = /<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/

const ATTRIBUTE = /\b([a-z-]+)="([^"]*)"/g

const REF_SUFFIX = /\s*\[[0-9a-f]{4,}\]\s*$/i

const SELF_LINE = /^This session is (.+?) \[[0-9a-f]+\]/m

// `  name [ref]  ·  kind  ·  status  ·  started 7d ago`
const PEER_LINE = /^\s+(.+?) \[[0-9a-f]+\]\s+·\s+([^·]+?)\s+·\s+([^·]+?)\s*(?:·.*)?$/

/**
 * A peer's address as SendMessage or a listing writes it, without the
 * ` [ref]` suffix that only disambiguates two sessions of one name.
 */
export function nameOf(address: string): string {
  return address.replace(REF_SUFFIX, '').trim()
}

/**
 * Who sent a delivery and what it says, from the envelope the engine frames
 * a peer's words in: `<cross-session-message from="uds:…" from-name="api">`.
 * The name the sender gave (`from-name`) when there is one, since `from` is
 * its socket address; the whole text under UNKNOWN_PEER without an envelope.
 */
export function inboundOf(text: string): { peer: string; text: string } {
  const match = WRAPPED.exec(text)

  if (!match) {
    return { peer: UNKNOWN_PEER, text: text.trim() }
  }

  const attributes = new Map(
    [...(match[1] ?? '').matchAll(ATTRIBUTE)].map(([, key, value]) => [key, value ?? '']),
  )
  const sender = attributes.get('from-name') || nameOf(attributes.get('from') ?? '')

  return { peer: sender || UNKNOWN_PEER, text: (match[2] ?? '').trim() }
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
      : { ...thread.unread, [entry.peer]: (thread.unread[entry.peer] ?? 0) + 1 },
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
 * The thread with the peers a fresh listing reported.
 */
export function withListing(
  thread: Thread,
  listing: { self?: string; peers: readonly Peer[] },
): Thread {
  const self = listing.self ?? thread.self

  return self === undefined
    ? { ...thread, peers: listing.peers }
    : { ...thread, self, peers: listing.peers }
}

/**
 * Every conversation worth a row: each peer a message went to or came from,
 * then each local session ListAgents lists that nobody talked to yet. Most
 * recent first.
 */
export function conversationsOf(thread: Thread): Conversation[] {
  const byPeer = new Map<string, Conversation>()
  const statusOf = new Map(thread.peers.map(peer => [peer.name, peer.status]))

  for (const entry of thread.entries) {
    byPeer.set(entry.peer, {
      peer: entry.peer,
      status: statusOf.get(entry.peer),
      unread: thread.unread[entry.peer] ?? 0,
      last: entry,
    })
  }

  const active = [...byPeer.values()].sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0))

  const idle = thread.peers
    .filter(peer => peer.kind === 'interactive' && !byPeer.has(peer.name))
    .map(peer => ({ peer: peer.name, status: peer.status, unread: 0 }))

  return [...active, ...idle]
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
