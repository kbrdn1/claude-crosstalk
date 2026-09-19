import type { On, ToolCallInput } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import * as Thread from '../hooks/thread'
import { CROSSTALK, fromPeer, JOURNAL, LISTING, PANE, SESSION, textOf } from './fixtures'

const JOURNAL_FILE = '/home/me/.claude/projects/-work/s1.jsonl'

/**
 * The world beneath crosstalk: a clock, session s1 in HOME /home/me whose
 * journal holds `journal`, a store holding `stored`, ListAgents answering
 * LISTING, SendMessage answering sent and remembering every call, panes
 * opening.
 */
function world(on: On, journal: string[] = [], stored: Record<string, unknown> = {}) {
  const sent: ToolCallInput[] = []
  const opened: string[] = []
  const statuses: (string | undefined)[] = []
  const runs: (readonly string[])[] = []
  const store = new Map(Object.entries(stored))

  const clock = mock.clock(on)

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.receive', ($, e) => ({ text: e.text }))
  on('session.id', () => ({ value: 's1' }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('process.run', ($, e) => {
    runs.push(e.argv)

    const stdout = e.argv[0] === 'find' ? `${JOURNAL_FILE}\n` : journal.join('\n')

    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', ($, e) => {
    store.delete(e.key)

    return { value: undefined }
  })

  on('tool.call', { tool: 'ListAgents' }, () => ({ result: { listing: LISTING } }))
  on('tool.call', { tool: 'SendMessage' }, ($, e) => {
    sent.push(e)

    // What SendMessage answers for a recipient no session answers to.
    return Reflect.get(e, 'to') === 'gone'
      ? {
          result: {
            success: false,
            message: 'No agent named gone',
            display: 'Not sent — no agent named gone is reachable.',
          },
        }
      : { result: { success: true } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: opened.map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })),
  }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })

  return { sent, opened, statuses, runs, store, clock }
}

/**
 * Opens `peer`'s conversation from the inbox, as the person's ⏎ on its row.
 */
async function opened($: Engine, peer: string): Promise<void> {
  await $.ui.render(PANE)
  await $.ui.press({ plugin: 'crosstalk', key: `open:${peer}` })
}

describe('register', () => {
  test('/crosstalk opens the pane and lists the local peers', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    expect(await $.command.run(CROSSTALK)).toEqual({})
    expect(w.opened).toEqual(['crosstalk'])
    await w.clock.advance(500)
    expect(w.opened, 'asks for the keyboard again once the composer is empty').toEqual([
      'crosstalk',
      'crosstalk',
    ])

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'crosstalk', ...PANE, surface })

      expect(textOf(await ui.drawn()), surface).toContain('● claude-98')
      expect(
        (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => k?.startsWith('open:')),
        'offline and cloud peers are no conversation',
      ).toEqual(['open:api', 'open:web'])
      await ui.unmount()
    }
  })

  test('a peer message is drawn under its sender', async ($, on) => {
    world(on)

    await $.session.start(SESSION)
    await $.command.run(CROSSTALK)
    expect(await $.session.receive(fromPeer('api [a1aa87]', 'tests are green'))).toEqual({
      text: '<cross-session-message from="api [a1aa87]">tests are green</cross-session-message>',
    })
    await opened($, 'api')

    const drawn = textOf(await $.ui.render(PANE))

    expect(drawn).toContain('api · ')
    expect(drawn).toContain('tests are green')
  })

  test('a Remote Control prompt is not a peer message', async ($, on) => {
    world(on)

    await $.session.start(SESSION)
    await $.session.receive({ origin: { kind: 'bridge' }, text: 'from my phone' })
    await $.command.run(CROSSTALK)

    expect(textOf(await $.ui.render(PANE))).not.toContain('from my phone')
  })

  test("the session's own SendMessage is drawn as sent", async ($, on) => {
    world(on)

    await $.session.start(SESSION)
    await $.tool.call({ tool: 'SendMessage', to: 'web [ef57a2]', message: 'ship it' })
    await $.command.run(CROSSTALK)
    await opened($, 'web')

    const drawn = textOf(await $.ui.render(PANE))

    expect(drawn).toMatch(/you · \d\d:\d\d/)
    expect(drawn).toContain('ship it')
  })

  test('a reply typed in the pane goes to the selected peer', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'ready?'))
    await $.command.run(CROSSTALK)

    const ui = await $.ui.mount({ plugin: 'crosstalk', ...PANE, surface: 'terminal' as const })
    await ui.press({ key: 'open:api' })

    await ui.input({ key: 'reply', text: 'yes, go', kind: 'submit' })
    await w.clock.settle()
    await ui.redraw()

    expect(w.sent.map(e => [e.tool, Reflect.get(e, 'to'), Reflect.get(e, 'message')])).toEqual([
      ['SendMessage', 'api', 'yes, go'],
    ])
    expect(textOf(await ui.drawn())).toContain('yes, go')
  })

  test('a reload with the pane still up picks the peers back up', async ($, on) => {
    const w = world(on)

    w.opened.push('crosstalk')
    await $.session.start(SESSION)

    const ui = await $.ui.mount({ plugin: 'crosstalk', ...PANE, surface: 'terminal' as const })

    expect(textOf(await ui.drawn())).toContain('● claude-98')
  })

  test("a session's first start rebuilds what its journal holds, unread none", async ($, on) => {
    const w = world(on, JOURNAL)

    await $.session.start(SESSION)
    expect(w.runs).toEqual([
      ['find', '/home/me/.claude/projects', '-maxdepth', '2', '-name', 's1.jsonl'],
      ['grep', '-E', Thread.JOURNAL_PATTERN, JOURNAL_FILE],
    ])
    expect(w.statuses.filter(Boolean), 'history is no unread').toEqual([])
    await $.command.run(CROSSTALK)

    const ui = await $.ui.mount({ plugin: 'crosstalk', ...PANE, surface: 'terminal' as const })

    expect(textOf(await ui.drawn())).toContain('deployed')
    await ui.press({ key: 'open:api' })
    await ui.redraw()

    const api = textOf(await ui.drawn())

    expect(api).toContain('ready?')
    expect(api, "the model's answer at api's socket files under api").toContain('yes, go')
  })

  test('a saved thread wins over the journal, pane replies included', async ($, on) => {
    const saved = Thread.toSaved(
      Thread.record(Thread.EMPTY, { dir: 'out', peer: 'api', text: 'typed in the pane', at: 1 }),
      1,
    )
    const w = world(on, JOURNAL, { 'thread:s1': saved })

    await $.session.start(SESSION)
    expect(w.runs, 'the journal is read on a first start only').toEqual([])
    await $.command.run(CROSSTALK)
    await opened($, 'api')

    expect(textOf(await $.ui.render(PANE))).toContain('typed in the pane')
  })

  test('every message is saved for the next start', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'ping'))
    await $.tool.call({ tool: 'SendMessage', to: 'api', message: 'pong' })

    expect(Thread.fromSaved(w.store.get('thread:s1'))?.entries.map(e => e.text)).toEqual([
      'ping',
      'pong',
    ])
  })

  test("a model's answer at a peer's socket joins its named conversation", async ($, on) => {
    world(on)

    await $.session.start(SESSION)
    await $.session.receive({
      origin: { kind: 'peer' },
      text: '<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="api">ready?</cross-session-message>',
    })
    await $.tool.call({ tool: 'SendMessage', to: 'uds:/tmp/cc-socks/1.sock', message: 'yes' })
    await $.command.run(CROSSTALK)

    const ui = await $.ui.mount({ plugin: 'crosstalk', ...PANE, surface: 'terminal' as const })

    expect(
      (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => k?.startsWith('open:')),
    ).toEqual(['open:api', 'open:web'])
    expect(textOf(await ui.drawn())).toContain('yes')
  })

  test('a SendMessage no session answered is no message sent', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await $.tool.call({ tool: 'SendMessage', to: 'gone', message: 'lost' })
    await $.session.receive(fromPeer('gone', 'still here?'))
    await $.command.run(CROSSTALK)

    const ui = await $.ui.mount({ plugin: 'crosstalk', ...PANE, surface: 'terminal' as const })
    await ui.press({ key: 'open:gone' })

    expect(textOf(await ui.drawn())).not.toContain('lost')

    await ui.input({ key: 'reply', text: 'you there?', kind: 'submit' })
    await w.clock.settle()
    await ui.redraw()

    const drawn = textOf(await ui.drawn())

    expect(drawn, 'a refused reply is not drawn as sent').not.toContain('you there?')
    expect(drawn, 'the reason shows in the pane, which holds toasts').toContain(
      'not sent: Not sent — no agent named gone is reachable.',
    )
  })

  test('a reply to a peer no longer listed goes to its socket', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await $.session.receive({
      origin: { kind: 'peer' },
      text: '<cross-session-message from="uds:/tmp/cc-socks/9.sock" from-name="claude-98">hi</cross-session-message>',
    })
    await $.command.run(CROSSTALK)

    const ui = await $.ui.mount({ plugin: 'crosstalk', ...PANE, surface: 'terminal' as const })
    await ui.press({ key: 'open:claude-98' })

    await ui.input({ key: 'reply', text: 'hello', kind: 'submit' })
    await w.clock.settle()

    expect(w.sent.map(e => Reflect.get(e, 'to'))).toEqual(['uds:/tmp/cc-socks/9.sock'])
  })

  test('the store keeps the 50 most recent sessions', async ($, on) => {
    const stored = Object.fromEntries(
      Array.from({ length: 52 }, (_, i) => [
        `thread:old${i}`,
        { savedAt: i, entries: [], aliases: {} },
      ]),
    )
    const w = world(on, [], { ...stored, unrelated: 1 })

    await $.session.start(SESSION)

    expect(w.store.has('thread:old0')).toBe(false)
    expect(w.store.has('thread:old1')).toBe(false)
    expect(w.store.has('thread:old2')).toBe(true)
    expect(w.store.has('unrelated')).toBe(true)
  })

  test('a wide pane draws your side on the right, a narrow one stacks it left', async ($, on) => {
    world(on)

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'ready?'))
    await $.tool.call({ tool: 'SendMessage', to: 'api', message: 'yes' })
    await $.command.run(CROSSTALK)
    await opened($, 'api')

    const wide = await $.ui.render({ ...PANE, props: { ...PANE.props, bodyColumns: 80 } })
    const narrow = await $.ui.render({ ...PANE, props: { ...PANE.props, bodyColumns: 36 } })

    expect(textOf(wide), 'your bar on the right').toContain('yes┃')
    expect(textOf(wide)).toContain('⏎ send · esc normal mode')
    expect(textOf(narrow), 'your bar on the left').toContain('┃yes')
    expect(textOf(narrow)).toContain('⏎ send · esc normal')
  })

  test('an unfocused pane says how to reach it', async ($, on) => {
    world(on)

    await $.session.start(SESSION)
    await $.command.run(CROSSTALK)

    expect(
      textOf(await $.ui.render({ ...PANE, props: { ...PANE.props, isFocused: false } })),
    ).toContain('ctrl+x tab')
  })

  test('a long thread shows its newest messages; earlier and newer page through it', async ($, on) => {
    world(on)

    await $.session.start(SESSION)

    for (let i = 0; i < 30; i++) {
      await $.session.receive(fromPeer('api', `message ${i}`))
    }

    await $.command.run(CROSSTALK)

    const ui = await $.ui.mount({
      plugin: 'crosstalk',
      ...PANE,
      surface: 'terminal' as const,
      props: { ...PANE.props, scroll: { offset: 0, bodyRows: 16 } },
    })
    await ui.press({ key: 'open:api' })
    await ui.redraw()
    const bottom = textOf(await ui.drawn())

    expect(bottom).toContain('message 29')
    expect(bottom).toMatch(/↑ \d+ earlier/)
    expect(bottom).not.toContain('newer')

    await ui.press({ key: 'older' })
    await ui.redraw()

    const back = textOf(await ui.drawn())

    expect(back).not.toContain('message 29')
    expect(back).toMatch(/↓ \d+ newer/)

    await ui.press({ key: 'newer' })
    await ui.redraw()

    expect(textOf(await ui.drawn())).toContain('message 29')
  })

  test('the inbox shows each conversation whole: name, unread, preview, time', async ($, on) => {
    world(on)

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('test-655-fmt-clippy-guards', 'audit is next\nsecond line'))
    await $.tool.call({ tool: 'SendMessage', to: 'api', message: 'ship it' })
    await $.command.run(CROSSTALK)

    const drawn = textOf(await $.ui.render(PANE))

    expect(drawn, 'no name cut at 64 columns').toContain('test-655-fmt-clippy-guards')
    expect(drawn).toContain('audit is next')
    expect(drawn).not.toContain('second line')
    expect(drawn).toContain('you: ship it')
    expect(drawn, 'an idle local session with nothing said').toContain('no message yet')
    expect(drawn, 'its unread count, then its time').toMatch(
      /test-655-fmt-clippy-guards1 {2}\d\d:\d\d/,
    )
  })

  test('a row opens its thread, read; back returns to the inbox', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'ready?'))
    await $.command.run(CROSSTALK)
    await w.clock.advance(500)

    const asked = w.opened.length

    await opened($, 'api')

    const thread = textOf(await $.ui.render(PANE))

    expect(thread).toContain('‹ api')
    expect(thread).toContain('ready?')
    expect(w.statuses.at(-1), 'opened, it is read').toBeUndefined()
    await w.clock.advance(500)
    expect(w.opened.length, 'the pane asks for the keys again once the thread is drawn').toBe(
      asked + 1,
    )

    await $.ui.press({ plugin: 'crosstalk', key: 'back' })

    expect(textOf(await $.ui.render(PANE))).toContain('open')
    expect(textOf(await $.ui.render(PANE))).not.toContain('‹ api')
  })

  test("/crosstalk closes the pane from a thread too (only the person's esc goes back)", async ($, on) => {
    world(on)

    const closed: string[] = []

    on('ui.close', ($, e) => {
      closed.push(e.origin.kind)

      return { value: undefined }
    })

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'ready?'))
    await $.command.run(CROSSTALK)
    await opened($, 'api')

    expect(await $.command.run(CROSSTALK)).toEqual({ text: 'crosstalk closed' })
    expect(closed).toEqual(['plugin'])
  })

  test('reading one thread, a message elsewhere shows in its header', async ($, on) => {
    world(on)

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'ready?'))
    await $.command.run(CROSSTALK)
    await opened($, 'api')
    await $.session.receive(fromPeer('web', 'deployed'))
    await $.session.receive(fromPeer('api', 'still there?'))

    const drawn = textOf(await $.ui.render(PANE))

    expect(drawn).toContain('✉ 1')
    expect(drawn).toContain('still there?')
  })

  test('a draft stays with its conversation', async ($, on) => {
    world(on)

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'ready?'))
    await $.session.receive(fromPeer('web', 'deployed'))
    await $.command.run(CROSSTALK)

    const ui = await $.ui.mount({ plugin: 'crosstalk', ...PANE, surface: 'terminal' as const })

    await ui.press({ key: 'open:api' })
    await ui.redraw()
    await ui.input({ key: 'reply', text: 'half a thought', kind: 'change' })
    await ui.press({ key: 'back' })
    await ui.redraw()
    await ui.press({ key: 'open:web' })
    await ui.redraw()

    expect((await ui.find({ key: 'reply' }))?.props.value).toBe('')

    await ui.press({ key: 'back' })
    await ui.redraw()
    await ui.press({ key: 'open:api' })
    await ui.redraw()

    expect((await ui.find({ key: 'reply' }))?.props.value).toBe('half a thought')
  })

  test('/crosstalk opens on the inbox again', async ($, on) => {
    world(on)
    on('ui.close', () => ({ value: undefined }))

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'ready?'))
    await $.command.run(CROSSTALK)
    await opened($, 'api')
    await $.command.run(CROSSTALK)
    await $.command.run(CROSSTALK)

    expect(textOf(await $.ui.render(PANE))).not.toContain('‹ api')
  })

  test('a message arriving while the pane is closed shows as unread', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'ping'))

    expect(w.statuses.at(-1)).toBe('crosstalk · 1 unread')
  })
})
