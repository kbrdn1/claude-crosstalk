import { describe, expect, test } from 'claude-code/testing'

import * as Thread from '../hooks/thread'
import { AT, JOURNAL, JOURNAL_2_1_312, LISTING } from './fixtures'

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

  test('a 2.1.312 journal: a send to a teammate is no message, a blob row no second send', async () => {
    const pattern = new RegExp(Thread.JOURNAL_PATTERN)
    const thread = Thread.fromJournal(JOURNAL_2_1_312.filter(line => pattern.test(line)))

    expect(thread.entries.map(e => [e.dir, e.peer, e.text.slice(0, 30)])).toEqual([
      ['in', 'claude-crosstalk-be', '[demo] crosstalk live check: w'],
      ['out', 'claude-crosstalk-3e', '[demo] crosstalk live check of'],
    ])
    expect(thread.aliases).toEqual({ 'uds:/tmp/cc-socks/6971.sock': 'claude-crosstalk-be' })
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

    expect(Thread.fromSaved(saved)).toEqual({
      ...Thread.EMPTY,
      entries: thread.entries,
      aliases: thread.aliases,
      selected: 'web',
    })
    expect(Thread.savedAtOf(saved)).toBe(42)
    expect(Thread.fromSaved('garbage')).toBeUndefined()
    expect(Thread.fromSaved({ entries: [{ dir: 'in', peer: 1 }], aliases: {} })?.entries).toEqual(
      [],
    )
  })

  test('history is capped, oldest first out', async () => {
    let thread = Thread.EMPTY

    for (let at = 0; at < Thread.MAX_ENTRIES + 5; at++) {
      thread = Thread.record(thread, { dir: 'out', peer: 'api', text: String(at), at })
    }

    expect(thread.entries).toHaveLength(Thread.MAX_ENTRIES)
    expect(thread.entries[0]?.text).toBe('5')
  })

  test('read up to a time: only what came in after it stays unread', async () => {
    let thread = Thread.EMPTY

    thread = Thread.record(thread, { dir: 'in', peer: 'api', text: 'a', at: 1 })
    thread = Thread.record(thread, { dir: 'in', peer: 'api', text: 'b', at: 2 })
    thread = Thread.record(thread, { dir: 'in', peer: 'api', text: 'c', at: 3 })
    thread = Thread.record(thread, { dir: 'in', peer: 'web', text: 'd', at: 3 })

    expect(Thread.readUpTo(thread, 'api', 2).unread).toEqual({ api: 1, web: 1 })
    expect(Thread.readUpTo(thread, 'api', 3).unread).toEqual({ web: 1 })
    expect(
      Thread.readUpTo(Thread.select(thread, 'api'), 'api', 0).unread,
      'never more unread than before',
    ).toEqual({ web: 1 })
  })

  test('a handled outbox id is kept, the most recent ones only', async () => {
    let thread = Thread.EMPTY

    for (let at = 0; at < Thread.MAX_HANDLED + 5; at++) {
      thread = Thread.withHandled(thread, `id-${at}`, { status: 'sent', at })
    }

    expect(Object.keys(thread.handled)).toHaveLength(Thread.MAX_HANDLED)
    expect(thread.handled['id-4']).toBeUndefined()
    expect(thread.handled['id-5']).toEqual({ status: 'sent', at: 5 })
  })

  test('an id still in the outbox is never forgotten, however many came after', async () => {
    let thread = Thread.withHandled(Thread.EMPTY, 'old', { status: 'sent', at: 0 })

    for (let at = 1; at <= Thread.MAX_HANDLED + 5; at++) {
      thread = Thread.withHandled(thread, `id-${at}`, { status: 'sent', at }, ['old'])
    }

    expect(thread.handled.old).toEqual({ status: 'sent', at: 0 })
    expect(Object.keys(thread.handled)).toHaveLength(Thread.MAX_HANDLED)
    expect(thread.handled['id-6'], 'the oldest of the others go first').toBeUndefined()
    expect(thread.handled['id-7']).toEqual({ status: 'sent', at: 7 })
  })

  test('handled ids are saved; one a reload cut off mid-send comes back refused', async () => {
    let thread = Thread.record(Thread.EMPTY, {
      dir: 'out',
      peer: 'api',
      text: 'from herdr',
      at: 1,
      id: 'h1',
    })

    thread = Thread.withHandled(thread, 'h1', { status: 'sent', at: 1 })
    thread = Thread.withHandled(thread, 'h2', { status: 'pending', at: 2 })

    const back = Thread.fromSaved(JSON.parse(JSON.stringify(Thread.toSaved(thread, 3))))

    expect(back?.entries[0]?.id).toBe('h1')
    expect(back?.handled.h1).toEqual({ status: 'sent', at: 1 })
    expect(back?.handled.h2).toEqual({
      status: 'refused',
      reason: Thread.INTERRUPTED,
      at: 2,
    })
  })

  test("Herdr's view: the session, each conversation, its messages, each outbox result", async () => {
    let thread = Thread.withListing(Thread.EMPTY, Thread.listingOf(LISTING))

    thread = Thread.withAlias(thread, 'uds:/9.sock', 'gone')
    thread = Thread.record(thread, { dir: 'in', peer: 'gone', text: 'bye', at: 1 })
    thread = Thread.record(thread, { dir: 'in', peer: 'api', text: '**ready?**', at: 2 })
    thread = Thread.record(thread, { dir: 'out', peer: 'api', text: 'yes', at: 3, id: 'h1' })
    thread = Thread.withHandled(thread, 'h1', { status: 'sent', at: 3 })
    thread = Thread.withHandled(thread, 'h2', { status: 'refused', reason: 'unknown peer', at: 4 })
    thread = Thread.withHandled(thread, 'h3', { status: 'pending', at: 5 })

    expect(Thread.herdrOf(thread, 's1', 9)).toEqual({
      v: 1,
      session: { id: 's1', name: 'claude-98' },
      updatedAt: 9,
      peers: [
        {
          name: 'api',
          address: 'api',
          status: 'idle',
          unread: 1,
          last: { dir: 'out', text: 'yes', at: 3 },
        },
        {
          name: 'gone',
          address: 'uds:/9.sock',
          unread: 1,
          last: { dir: 'in', text: 'bye', at: 1 },
        },
        { name: 'web', address: 'web', status: 'busy', unread: 0 },
      ],
      threads: {
        gone: [{ dir: 'in', text: 'bye', at: 1 }],
        api: [
          { dir: 'in', text: '**ready?**', at: 2 },
          { dir: 'out', text: 'yes', at: 3, id: 'h1' },
        ],
      },
      handled: {
        h1: { status: 'sent', at: 3 },
        h2: { status: 'refused', reason: 'unknown peer', at: 4 },
      },
    })
    expect(Thread.herdrOf(Thread.EMPTY, 's1', 0).session, 'no name before a listing').toEqual({
      id: 's1',
    })
  })

  test("Herdr's outbox: its sends and read marks; anything else is none", async () => {
    expect(
      Thread.outboxOf(
        JSON.stringify({
          session: 's1',
          v: 1,
          send: [
            { id: 'h1', to: 'api', text: 'hi', at: 1 },
            { id: 'h2', to: 3, text: null },
            { to: 'api', text: 'no id, no answer' },
          ],
          read: { api: 5, web: 'soon' },
        }),
        's1',
      ),
    ).toEqual({
      send: [
        { id: 'h1', to: 'api', text: 'hi' },
        { id: 'h2', to: '', text: '' },
      ],
      read: { api: 5 },
    })
    expect(Thread.outboxOf('{"v":1}', 's1'), 'no session named: this one').toEqual({
      send: [],
      read: {},
    })
    expect(
      Thread.outboxOf('{"v":1,"send":[{"id":"h1"', 's1'),
      'a half-written file',
    ).toBeUndefined()
  })

  test('an outbox for another session, or of another version, asks nothing', async () => {
    const asks = { send: [{ id: 'h1', to: 'api', text: 'hi' }], read: { api: 5 } }
    const none = { send: [], read: {} }

    expect(Thread.outboxOf(JSON.stringify({ v: 1, session: 's0', ...asks }), 's1')).toEqual(none)
    expect(Thread.outboxOf(JSON.stringify({ v: 2, session: 's1', ...asks }), 's1')).toEqual(none)
    expect(Thread.outboxOf(JSON.stringify({ session: 's1', ...asks }), 's1')).toEqual(none)
  })
})
