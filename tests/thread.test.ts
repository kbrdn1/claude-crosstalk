import { describe, expect, test } from 'claude-code/testing'

import * as Thread from '../hooks/thread'
import { LISTING } from './fixtures'

describe('thread', () => {
  test('a peer delivery names its sender and loses its envelope', async () => {
    expect(
      Thread.inboundOf(
        '<cross-session-message from="api [ab12cd]">\n  tests are green\n</cross-session-message>',
      ),
    ).toEqual({ peer: 'api', text: 'tests are green' })
  })

  test('a local peer is named by the name it gave, not its socket', async () => {
    expect(
      Thread.inboundOf(
        'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/95435.sock" from-name="claude-98" from-mode="bypass">\nhello\n</cross-session-message>\n\nThis came from another Claude session.',
      ),
    ).toEqual({ peer: 'claude-98', text: 'hello' })
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

  test('history is capped, oldest first out', async () => {
    let thread = Thread.EMPTY

    for (let at = 0; at < Thread.MAX_ENTRIES + 5; at++) {
      thread = Thread.record(thread, { dir: 'out', peer: 'api', text: String(at), at })
    }

    expect(thread.entries).toHaveLength(Thread.MAX_ENTRIES)
    expect(thread.entries[0]?.text).toBe('5')
  })
})
