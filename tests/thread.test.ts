import { describe, expect, test } from 'claude-code/testing'

import * as Thread from '../hooks/thread'
import { AT, JOURNAL, LISTING } from './fixtures'

describe('thread', () => {
  test('a peer delivery names its sender and loses its envelope', async () => {
    expect(
      Thread.inboundOf(
        '<cross-session-message from="api [ab12cd]">\n  tests are green\n</cross-session-message>',
      ),
    ).toEqual({ peer: 'api', text: 'tests are green', address: 'api [ab12cd]' })
  })

  test('a local peer is named by the name it gave, not its socket', async () => {
    expect(
      Thread.inboundOf(
        'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/95435.sock" from-name="claude-98" from-mode="bypass">\nhello\n</cross-session-message>\n\nThis came from another Claude session.',
      ),
    ).toEqual({ peer: 'claude-98', text: 'hello', address: 'uds:/tmp/cc-socks/95435.sock' })
  })

  test('a delivery without an envelope is kept whole, sender unknown', async () => {
    expect(Thread.inboundOf('  hello  ')).toEqual({ peer: Thread.UNKNOWN_PEER, text: 'hello' })
  })

  test('the listing gives this session and its peers, never its subagents', async () => {
    const listing = Thread.listingOf(LISTING)

    expect(listing.self).toBe('claude-98')
    expect(listing.peers).toEqual([
      { name: 'api', kind: 'interactive', status: 'idle' },
      { name: 'web', kind: 'interactive', status: 'busy' },
      { name: 'laptop-bubble', kind: 'Remote Control', status: 'offline' },
      { name: 'ultrareview: HEAD', kind: 'cloud', status: 'idle' },
    ])
  })

  test('an incoming message is unread until its conversation is shown', async () => {
    const at = 0
    const hidden = Thread.record(Thread.EMPTY, { dir: 'in', peer: 'api', text: 'a', at })
    const shown = Thread.record(Thread.EMPTY, { dir: 'in', peer: 'api', text: 'a', at }, true)

    expect(hidden.unread).toEqual({ api: 1 })
    expect(shown.unread).toEqual({})
    expect(Thread.select(hidden, 'api').unread).toEqual({})
  })

  test('conversations: talked-to peers by recency, then idle local sessions', async () => {
    let thread = Thread.withListing(Thread.EMPTY, Thread.listingOf(LISTING))

    thread = Thread.record(thread, { dir: 'out', peer: 'web', text: 'x', at: 1 })
    thread = Thread.record(thread, { dir: 'in', peer: 'api', text: 'y', at: 2 })

    expect(Thread.conversationsOf(thread).map(c => c.peer)).toEqual(['api', 'web'])

    const fresh = Thread.withListing(Thread.EMPTY, Thread.listingOf(LISTING))

    expect(Thread.conversationsOf(fresh).map(c => c.peer)).toEqual(['api', 'web'])
  })

  test('the journal rebuilds both directions with their times, all read', async () => {
    const thread = Thread.fromJournal(JOURNAL)

    expect(thread.entries).toEqual([
      { dir: 'in', peer: 'api', text: 'ready?', at: AT('2026-09-19T10:00:01.000Z') },
      { dir: 'out', peer: 'api', text: 'yes, go', at: AT('2026-09-19T10:00:05.000Z') },
      { dir: 'in', peer: 'web', text: 'deployed', at: AT('2026-09-19T10:01:00.000Z') },
    ])
    expect(thread.unread).toEqual({})
    expect(thread.selected).toBe('web')
  })

  test('the grep pattern keeps peer deliveries and SendMessage calls only', async () => {
    const pattern = new RegExp(Thread.JOURNAL_PATTERN)

    expect(JOURNAL.map(line => pattern.test(line))).toEqual([false, true, true, true, true, false])
  })

  test("a reply at a peer's socket address files under its name", async () => {
    const thread = Thread.withAlias(Thread.EMPTY, 'uds:/tmp/cc-socks/1.sock', 'api')

    expect(Thread.peerOf(thread, 'uds:/tmp/cc-socks/1.sock')).toBe('api')
    expect(Thread.peerOf(thread, 'web [ab12cd]')).toBe('web')
  })

  test('a peer renamed at the same address takes its conversation along', async () => {
    let thread = Thread.withAlias(Thread.EMPTY, 'uds:/1.sock', 'claude-98')

    thread = Thread.record(thread, { dir: 'in', peer: 'claude-98', text: 'hi', at: 1 })
    thread = Thread.withAlias(thread, 'uds:/1.sock', 'claude-crosstalk')

    expect(thread.entries.map(e => e.peer)).toEqual(['claude-crosstalk'])
    expect(thread.unread).toEqual({ 'claude-crosstalk': 1 })
    expect(thread.selected).toBe('claude-crosstalk')
    expect(Thread.peerOf(thread, 'uds:/1.sock')).toBe('claude-crosstalk')
  })

  test('a reply goes to the listed name, else to the address the peer wrote from', async () => {
    const known = Thread.withAlias(Thread.EMPTY, 'uds:/1.sock', 'claude-98')

    expect(Thread.addressOf(known, 'claude-98'), 'not listed: its socket').toBe('uds:/1.sock')
    expect(
      Thread.addressOf(Thread.withListing(known, Thread.listingOf(LISTING)), 'api'),
      'listed: its name',
    ).toBe('api')
    expect(Thread.addressOf(Thread.EMPTY, 'web'), 'nothing known: its name').toBe('web')
  })

  test('a saved thread comes back as it was; anything else is none', async () => {
    const thread = Thread.fromJournal(JOURNAL)
    const saved = JSON.parse(JSON.stringify(Thread.toSaved(thread, 42)))

    expect(Thread.fromSaved(saved)).toEqual({ ...Thread.EMPTY, entries: thread.entries, aliases: thread.aliases, selected: 'web' })
    expect(Thread.savedAtOf(saved)).toBe(42)
    expect(Thread.fromSaved('garbage')).toBeUndefined()
    expect(Thread.fromSaved({ entries: [{ dir: 'in', peer: 1 }], aliases: {} })?.entries).toEqual([])
  })

  test('history is capped, oldest first out', async () => {
    let thread = Thread.EMPTY

    for (let at = 0; at < Thread.MAX_ENTRIES + 5; at++) {
      thread = Thread.record(thread, { dir: 'out', peer: 'api', text: String(at), at })
    }

    expect(thread.entries).toHaveLength(Thread.MAX_ENTRIES)
    expect(thread.entries[0]?.text).toBe('5')
  })
})
