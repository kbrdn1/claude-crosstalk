import type { On, ToolCallInput } from 'claude-code'
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

    return { result: { success: true } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: undefined }
  })
  on('ui.panes', () => ({ value: opened.map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })) }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })

  return { sent, opened, statuses, runs, store, clock }
}

describe('register', () => {
  test('/crosstalk opens the pane and lists the local peers', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    expect(await $.command.run(CROSSTALK)).toEqual({})
    expect(w.opened).toEqual(['crosstalk'])

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'crosstalk', ...PANE, surface })
      const picker = await ui.find({ key: 'peer' })

      expect(textOf(await ui.drawn()), surface).toContain('you are claude-98')
      expect(picker?.props.options, 'offline and cloud peers are no conversation').toEqual([
        { value: 'api', label: 'api  idle' },
        { value: 'web', label: 'web  busy' },
      ])
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

    const drawn = textOf(await $.ui.render(PANE))

    expect(drawn).toContain('← api')
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

    const drawn = textOf(await $.ui.render(PANE))

    expect(drawn).toContain('→ you')
    expect(drawn).toContain('ship it')
  })

  test('a reply typed in the pane goes to the selected peer', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'ready?'))
    await $.command.run(CROSSTALK)

    const ui = await $.ui.mount({ plugin: 'crosstalk', ...PANE, surface: 'terminal' as const })

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

    expect(textOf(await ui.drawn())).toContain('you are claude-98')
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
    await ui.select({ key: 'peer', value: 'api' })
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

    expect(textOf(await $.ui.render(PANE))).toContain('typed in the pane')
  })

  test('every message is saved for the next start', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'ping'))
    await $.tool.call({ tool: 'SendMessage', to: 'api', message: 'pong' })

    expect(Thread.fromSaved(w.store.get('thread:s1'))?.entries.map(e => e.text)).toEqual(['ping', 'pong'])
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

    expect((await ui.find({ key: 'peer' }))?.props.options).toEqual([
      { value: 'api', label: 'api  idle' },
      { value: 'web', label: 'web  busy' },
    ])
    expect(textOf(await ui.drawn())).toContain('yes')
  })

  test('the store keeps the 50 most recent sessions', async ($, on) => {
    const stored = Object.fromEntries(
      Array.from({ length: 52 }, (_, i) => [`thread:old${i}`, { savedAt: i, entries: [], aliases: {} }]),
    )
    const w = world(on, [], { ...stored, unrelated: 1 })

    await $.session.start(SESSION)

    expect(w.store.has('thread:old0')).toBe(false)
    expect(w.store.has('thread:old1')).toBe(false)
    expect(w.store.has('thread:old2')).toBe(true)
    expect(w.store.has('unrelated')).toBe(true)
  })

  test('a message arriving while the pane is closed shows as unread', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'ping'))

    expect(w.statuses.at(-1)).toBe('crosstalk · 1 unread')
  })
})
