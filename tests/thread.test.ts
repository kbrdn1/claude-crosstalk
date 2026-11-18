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

  test("a name Herdr's directory resolves files its conversation under the session id", async () => {
    let thread = Thread.withListing(Thread.EMPTY, {
      self: 'me-00',
      peers: [{ name: 'api-1d', kind: 'interactive', status: 'idle' }],
    })

    thread = Thread.withDirectory(thread, [
      { id: 'S1', name: 'api-1d', project: 'api', topic: '#61' },
      { id: 'S2', name: 'gone-00' },
      { id: 'S0', name: 'me-00' },
    ])

    expect(Thread.keyOf(thread, 'api-1d')).toBe('S1')
    expect(Thread.keyOf(thread, 'gone-00'), 'a name nobody lists maps to nothing').toBe('gone-00')
    expect(Thread.keyOf(thread, 'me-00'), 'nor this session').toBe('me-00')
    expect(Thread.peerOf(thread, 'api-1d [ab12cd]')).toBe('S1')
    expect(Thread.addressOf(thread, 'S1'), 'a reply goes to its live name').toBe('api-1d')
  })

  test('a conversation that resolves takes everything keyed by it to the session id', async () => {
    let thread = Thread.withListing(
      Thread.EMPTY,
      { peers: [{ name: 'api-fd', kind: 'interactive', status: 'idle' }] },
      5,
    )

    thread = Thread.withAlias(thread, 'uds:/1.sock', 'api-fd')
    thread = Thread.record(thread, { dir: 'in', peer: 'api-fd', text: 'a', at: 1 })
    thread = Thread.record(thread, { dir: 'in', peer: 'api-fd', text: 'b', at: 2 })
    thread = Thread.readUpTo(thread, 'api-fd', 1)
    thread = Thread.withTitle(thread, 'api-fd', 'API backend')
    thread = Thread.withDirectory(thread, [{ id: 'S1', name: 'api-fd', project: 'api' }])

    expect(thread.entries.map(e => e.peer)).toEqual(['S1', 'S1'])
    expect(thread.unread, 'the read mark kept: one unread, not two').toEqual({ S1: 1 })
    expect(thread.titles).toEqual({ S1: 'API backend' })
    expect(thread.seen).toEqual({ S1: 5 })
    expect(thread.selected).toBe('S1')
    expect(Thread.peerOf(thread, 'uds:/1.sock')).toBe('S1')

    // The session restarts under a new name: same id, same conversation.
    thread = Thread.withListing(
      thread,
      { peers: [{ name: 'api-1d', kind: 'interactive', status: 'busy' }] },
      9,
    )
    thread = Thread.withDirectory(thread, [{ id: 'S1', name: 'api-1d', project: 'api' }])

    expect(Thread.keyOf(thread, 'api-1d')).toBe('S1')
    expect(Thread.keyOf(thread, 'api-fd'), 'its old name maps to nothing now').toBe('api-fd')
    expect(thread.seen).toEqual({ S1: 9 })
    expect(Thread.conversationsOf(thread).map(c => [c.peer, c.status])).toEqual([['S1', 'busy']])
  })

  test("a session id's own title wins over the one its old name carried", async () => {
    let thread = Thread.withListing(Thread.EMPTY, {
      peers: [{ name: 'api-fd', kind: 'interactive', status: 'idle' }],
    })

    thread = Thread.withTitle(thread, 'api-fd', 'old')
    thread = Thread.withTitle(thread, 'S1', 'given')
    thread = Thread.withDirectory(thread, [{ id: 'S1', name: 'api-fd' }])

    expect(thread.titles).toEqual({ S1: 'given' })
    expect(Thread.withTitle(thread, 'S1', '  ').titles, 'an empty title clears it').toEqual({})
  })

  test('a title: the given one, else project and topic, else project, else the name', async () => {
    let thread = Thread.withListing(Thread.EMPTY, {
      peers: [
        { name: 'flow-1d', kind: 'interactive', status: 'idle' },
        { name: 'web-2a', kind: 'interactive', status: 'idle' },
        { name: 'web-3b', kind: 'interactive', status: 'idle' },
        { name: 'app-4c', kind: 'interactive', status: 'idle' },
        { name: 'app-5d', kind: 'interactive', status: 'idle' },
        { name: 'Commande chmod 600', kind: 'Remote Control', status: 'offline' },
      ],
    })

    thread = Thread.withDirectory(thread, [
      { id: 'S1aa', name: 'flow-1d', project: 'claude-flow', topic: '#61' },
      { id: 'S2bb', name: 'web-2a', project: 'web' },
      { id: 'S3cc', name: 'web-3b', project: 'web' },
    ])
    thread = Thread.withTitle(thread, 'S3cc', 'the other web')

    expect(
      Thread.titlesOf(thread, ['S1aa', 'S2bb', 'S3cc', 'app-4c', 'app-5d', 'Commande chmod 600']),
    ).toEqual({
      S1aa: 'claude-flow · #61',
      S2bb: 'web',
      S3cc: 'the other web',
      'app-4c': 'app-4c',
      'app-5d': 'app-5d',
      'Commande chmod 600': 'Commande chmod 600',
    })

    const twins = Thread.withTitle(thread, 'S3cc', '')

    expect(Thread.titlesOf(twins, ['S2bb', 'S3cc']), 'one project, no topic: by id').toEqual({
      S2bb: 'web · S2bb',
      S3cc: 'web · S3cc',
    })
    expect(Thread.titlesOf(thread, ['app-4c']), 'alone, a name loses its suffix').toEqual({
      'app-4c': 'app',
    })
  })

  test("ListAgents' kinds as Herdr reads them", async () => {
    expect(['interactive', 'Remote Control', 'cloud', 'bg'].map(Thread.kindOf)).toEqual([
      'interactive',
      'remote',
      'cloud',
      'background',
    ])
  })

  test('what is known of a peer and when it was seen are saved; the name map is not', async () => {
    let thread = Thread.withListing(
      Thread.EMPTY,
      { peers: [{ name: 'api-1d', kind: 'interactive', status: 'idle' }] },
      7,
    )

    thread = Thread.withDirectory(thread, [{ id: 'S1', name: 'api-1d', project: 'api' }])
    thread = Thread.record(thread, { dir: 'out', peer: 'S1', text: 'x', at: 8 })

    const back = Thread.fromSaved(JSON.parse(JSON.stringify(Thread.toSaved(thread, 9))))

    expect(back?.known).toEqual({ S1: { name: 'api-1d', project: 'api' } })
    expect(back?.seen).toEqual({ S1: 7 })
    expect(back?.ids).toEqual({})
    expect(back?.titles, 'titles live in the shared store').toEqual({})
  })

  test('read up to a time: only what came in after it stays unread', async () => {
    let thread = Thread.EMPTY

    thread = Thread.record(thread, { dir: 'in', peer: 'api', text: 'a', at: 1 })
    thread = Thread.record(thread, { dir: 'in', peer: 'api', text: 'b', at: 2 })
    thread = Thread.record(thread, { dir: 'in', peer: 'api', text: 'c', at: 3 })
    thread = Thread.record(thread, { dir: 'in', peer: 'web', text: 'd', at: 3 })
    thread = Thread.record(thread, { dir: 'out', peer: 'api', text: 'a reply is no unread', at: 4 })

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

  test("a peer named like an object's own member is published as any other", async () => {
    let thread = Thread.EMPTY

    for (const peer of ['constructor', '__proto__', 'toString']) {
      thread = Thread.record(thread, { dir: 'out', peer, text: `to ${peer}`, at: 1 })
    }

    const threads = Thread.herdrOf(thread, { id: 's1' }, 0).threads

    expect(Object.keys(threads)).toEqual(['constructor', '__proto__', 'toString'])
    expect(Object.getOwnPropertyDescriptor(threads, '__proto__')?.value).toEqual([
      { dir: 'out', text: 'to __proto__', at: 1 },
    ])
  })

  test("a peer named like an object's own member counts its unread as any other", async () => {
    let thread = Thread.EMPTY

    thread = Thread.record(thread, { dir: 'in', peer: 'constructor', text: 'a', at: 1 })
    thread = Thread.record(thread, { dir: 'in', peer: 'constructor', text: 'b', at: 2 })

    expect(Thread.unreadCount(thread)).toBe(2)
    expect(
      Thread.herdrOf(Thread.readUpTo(thread, 'constructor', 1), { id: 's1' }, 0).peers,
    ).toEqual([
      {
        key: 'constructor',
        title: 'constructor',
        name: 'constructor',
        address: 'constructor',
        project: 'constructor',
        live: false,
        lastMessageAt: 2,
        unread: 1,
        last: { dir: 'in', text: 'b', at: 2 },
      },
    ])
  })

  test('a pending id whose message is in the thread comes back sent', async () => {
    let thread = Thread.record(Thread.EMPTY, {
      dir: 'out',
      peer: 'api',
      text: 'x',
      at: 1,
      id: 'h1',
    })

    thread = Thread.withHandled(thread, 'h1', { status: 'pending', at: 1 })

    expect(
      Thread.fromSaved(JSON.parse(JSON.stringify(Thread.toSaved(thread, 2))))?.handled,
    ).toEqual({ h1: { status: 'sent', at: 1 } })
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
    thread = Thread.withHandled(thread, 'h3', {
      status: 'refused',
      reason: 'unknown peer: x',
      at: 3,
    })

    const back = Thread.fromSaved(JSON.parse(JSON.stringify(Thread.toSaved(thread, 3))))

    expect(back?.entries[0]?.id).toBe('h1')
    expect(back?.handled.h1).toEqual({ status: 'sent', at: 1 })
    expect(back?.handled.h3).toEqual({ status: 'refused', reason: 'unknown peer: x', at: 3 })
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

    const self = { id: 's1', terminal: 't9', cwd: '/work/api', project: 'api' }

    expect(Thread.herdrOf(thread, self, 9)).toEqual({
      v: 2,
      session: { id: 's1', name: 'claude-98', terminal: 't9', cwd: '/work/api', project: 'api' },
      updatedAt: 9,
      peers: [
        {
          key: 'api',
          title: 'api',
          name: 'api',
          address: 'api',
          project: 'api',
          kind: 'interactive',
          status: 'idle',
          live: true,
          lastMessageAt: 3,
          unread: 1,
          last: { dir: 'out', text: 'yes', at: 3 },
        },
        {
          key: 'gone',
          title: 'gone',
          name: 'gone',
          address: 'uds:/9.sock',
          project: 'gone',
          live: false,
          lastMessageAt: 1,
          unread: 1,
          last: { dir: 'in', text: 'bye', at: 1 },
        },
        {
          key: 'web',
          title: 'web',
          name: 'web',
          address: 'web',
          project: 'web',
          kind: 'interactive',
          status: 'busy',
          live: true,
          unread: 0,
        },
        {
          key: 'laptop-bubble',
          title: 'laptop-bubble',
          name: 'laptop-bubble',
          address: 'laptop-bubble',
          project: 'laptop-bubble',
          kind: 'remote',
          status: 'offline',
          live: true,
          unread: 0,
        },
        {
          key: 'ultrareview: HEAD',
          title: 'ultrareview: HEAD',
          name: 'ultrareview: HEAD',
          address: 'ultrareview: HEAD',
          project: 'ultrareview: HEAD',
          kind: 'cloud',
          status: 'idle',
          live: true,
          unread: 0,
        },
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
    expect(
      Thread.herdrOf(Thread.EMPTY, { id: 's1' }, 0).session,
      'no name before a listing',
    ).toEqual({ id: 's1' })
  })

  test("Herdr's view of a resolved peer: its session id, title, topic, last seen", async () => {
    let thread = Thread.withListing(
      Thread.EMPTY,
      { peers: [{ name: 'flow-1d', kind: 'interactive', status: 'idle' }] },
      7,
    )

    thread = Thread.withDirectory(thread, [
      { id: 'S1aa', name: 'flow-1d', project: 'claude-flow', topic: '#61' },
    ])
    thread = Thread.record(thread, { dir: 'out', peer: 'S1aa', text: 'on it', at: 8 })

    const published = Thread.herdrOf(thread, { id: 's1' }, 9)

    expect(published.peers).toEqual([
      {
        key: 'S1aa',
        sessionId: 'S1aa',
        title: 'claude-flow · #61',
        name: 'flow-1d',
        address: 'flow-1d',
        project: 'claude-flow',
        topic: '#61',
        kind: 'interactive',
        status: 'idle',
        live: true,
        lastSeenAt: 7,
        lastMessageAt: 8,
        unread: 0,
        last: { dir: 'out', text: 'on it', at: 8 },
      },
    ])
    expect(published.threads).toEqual({ S1aa: [{ dir: 'out', text: 'on it', at: 8 }] })
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
      title: {},
    })
    expect(Thread.outboxOf('{"v":1}', 's1'), 'no session named: this one').toEqual({
      send: [],
      read: {},
      title: {},
    })
    expect(
      Thread.outboxOf(
        JSON.stringify({ v: 2, session: 's1', title: { S1: 'API backend', S2: '', S3: 7 } }),
        's1',
      ),
      'v2 names conversations; an empty title clears one',
    ).toEqual({ send: [], read: {}, title: { S1: 'API backend', S2: '' } })
    expect(
      Thread.outboxOf('{"v":1,"send":[{"id":"h1"', 's1'),
      'a half-written file',
    ).toBeUndefined()
  })

  test('an outbox for another session, or of another version, asks nothing', async () => {
    const asks = { send: [{ id: 'h1', to: 'api', text: 'hi' }], read: { api: 5 } }
    const none = { send: [], read: {}, title: {} }

    expect(Thread.outboxOf(JSON.stringify({ v: 1, session: 's0', ...asks }), 's1')).toEqual(none)
    expect(Thread.outboxOf(JSON.stringify({ v: 3, session: 's1', ...asks }), 's1')).toEqual(none)
    expect(Thread.outboxOf(JSON.stringify({ session: 's1', ...asks }), 's1')).toEqual(none)
  })
})
