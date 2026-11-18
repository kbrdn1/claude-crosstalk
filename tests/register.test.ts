import type { On, ToolCallInput, UiOpenResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { OUTBOX_MS, REFRESH_MS } from '../hooks/register'
import * as Thread from '../hooks/thread'
import {
  CROSSTALK,
  FROM_TEAMMATE,
  fromPeer,
  JOURNAL,
  LISTING,
  PANE,
  SESSION,
  textOf,
  TO_TEAMMATE,
} from './fixtures'

const JOURNAL_FILE = '/home/me/.claude/projects/-work/s1.jsonl'

const HERDR = '/home/me/.claude/cache/herdr'
const PUBLICATION = `${HERDR}/t9.crosstalk.json`
const OUTBOX = `${HERDR}/t9.crosstalk-outbox.json`

/**
 * The world beneath crosstalk: a clock, session s1 in HOME /home/me (and
 * `env` beside it) whose journal holds `journal`, a store holding `stored`,
 * files in memory, ListAgents answering LISTING, SendMessage answering sent
 * and remembering every call with the store as it stood, panes opening.
 */
function world(
  on: On,
  journal: string[] = [],
  stored: Record<string, unknown> = {},
  env: Record<string, string> = {},
) {
  const sent: ToolCallInput[] = []
  const storedAtSend: unknown[] = []
  const opened: string[] = []
  const statuses: (string | undefined)[] = []
  const runs: (readonly string[])[] = []
  const store = new Map(Object.entries(stored))
  const files = new Map<string, { text: string; mtimeMs: number }>()
  const fsCalls: string[] = []
  const listings: number[] = []
  const open: { result: UiOpenResult } = { result: { isPlaced: true } }
  // How `mv` exits: 0 moves the file.
  const mv = { exitCode: 0 }
  // How many reads fail next, and what a read waits for first.
  const reads: { failing: number; held?: Promise<void> } = { failing: 0 }
  // What the next write waits for before it lands.
  const writes: { holdNext?: Promise<void> } = {}
  // Whether the store refuses every save, how many reads of the titles fail
  // next, and what a save of the titles waits for first.
  const saves: { isFull: boolean; titleReadsFailing: number; holdTitles?: Promise<void> } = {
    isFull: false,
    titleReadsFailing: 0,
  }
  // What ListAgents answers.
  const agents = { listing: LISTING }
  let version = 0

  // What the next `clock.now` waits for before it answers: mock.clock owns
  // that hook, so its own is wrapped as it registers it.
  const nowHold: { next?: Promise<void> } = {}
  const holdingNow = (...args: unknown[]) => {
    const hook = args.at(-1)

    if (args[0] === 'clock.now' && typeof hook === 'function') {
      args[args.length - 1] = async (...call: unknown[]) => {
        const held = nowHold.next

        nowHold.next = undefined
        await held

        return Reflect.apply(hook, undefined, call)
      }
    }

    return Reflect.apply(on, undefined, args)
  }
  const clock = mock.clock(holdingNow as unknown as On)
  const missing = { deny: 'ENOENT: no such file or directory' }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.receive', ($, e) => ({ text: e.text }))
  on('session.id', () => ({ value: 's1' }))
  // The main working tree's root, a worktree's too: its name is the project.
  on('session.repo', () => ({
    value: { root: '/home/me/Projects/api', remote: null, internal: false, name: null },
  }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/home/me' : env[e.name] }))
  on('fs.write', async ($, e) => {
    const held = writes.holdNext

    fsCalls.push(`write ${e.path}`)
    writes.holdNext = undefined
    await held
    files.set(e.path, { text: e.text, mtimeMs: ++version })

    return { value: undefined }
  })
  on('fs.read', async ($, e) => {
    fsCalls.push(`read ${e.path}`)
    await reads.held

    const file = files.get(e.path)

    if (reads.failing > 0) {
      reads.failing -= 1

      return missing
    }

    return file === undefined ? missing : { value: file.text }
  })
  on('fs.stat', ($, e) => {
    fsCalls.push(`stat ${e.path}`)

    const file = files.get(e.path)

    return file === undefined
      ? missing
      : { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('fs.list', ($, e) => {
    fsCalls.push(`list ${e.path}`)

    const prefix = `${e.path ?? ''}/`
    const entries = [...files]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, file]) => ({
        name: path.slice(prefix.length),
        kind: 'file' as const,
        size: file.text.length,
        mtimeMs: file.mtimeMs,
        isLink: false,
      }))

    return { value: entries }
  })
  on('process.run', ($, e) => {
    runs.push(e.argv)

    const [command, , from = '', to = ''] = e.argv
    const moved = files.get(from)
    const isMove = command === 'mv'

    if (isMove && mv.exitCode === 0 && moved !== undefined) {
      files.delete(from)
      files.set(to, moved)
    }

    const stdout = e.argv[0] === 'find' ? `${JOURNAL_FILE}\n` : journal.join('\n')

    return {
      value: {
        exitCode: isMove ? mv.exitCode : 0,
        stdout,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('store.get', ($, e) => {
    if (e.key === 'titles' && saves.titleReadsFailing > 0) {
      saves.titleReadsFailing -= 1

      return { deny: 'the store could not be read' }
    }

    return { value: store.get(e.key) }
  })
  on('store.set', async ($, e) => {
    if (saves.isFull) {
      return { deny: 'the store is full' }
    }

    if (e.key === 'titles') {
      await saves.holdTitles
    }

    store.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', ($, e) => {
    store.delete(e.key)

    return { value: undefined }
  })

  on('tool.call', { tool: 'ListAgents' }, () => {
    listings.push(clock.now())

    return { result: { listing: agents.listing } }
  })
  on('tool.call', { tool: 'SendMessage' }, ($, e) => {
    sent.push(e)
    storedAtSend.push(JSON.parse(JSON.stringify(store.get('thread:s1') ?? null)))

    if (Reflect.get(e, 'to') === 'alpha') {
      return { result: TO_TEAMMATE }
    }

    // What SendMessage answers for a recipient no session answers to.
    return Reflect.get(e, 'to') === 'gone'
      ? {
          result: {
            success: false,
            message:
              "No agent named 'gone' is reachable.\nUse ListAgents to see everyone you can message.",
            display: "Not sent — no agent named 'gone' is reachable.",
          },
        }
      : { result: { success: true } }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: open.result }
  })
  on('ui.panes', () => ({
    value: opened.map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })),
  }))
  on('ui.status', ($, e) => {
    statuses.push(e.text)

    return { value: undefined }
  })

  return {
    sent,
    storedAtSend,
    opened,
    statuses,
    runs,
    store,
    files,
    fsCalls,
    listings,
    clock,
    open,
    mv,
    reads,
    writes,
    saves,
    nowHold,
    agents,
    // Herdr writing its outbox, as a new file each time.
    outbox: (value: unknown) =>
      files.set(OUTBOX, { text: JSON.stringify(value), mtimeMs: ++version }),
    // Another terminal's file in Herdr's folder, a newer one each time.
    herdrFile: (name: string, value: unknown) =>
      files.set(`${HERDR}/${name}`, { text: JSON.stringify(value), mtimeMs: ++version }),
    // What crosstalk last published for Herdr.
    published: (): Thread.Publication => JSON.parse(files.get(PUBLICATION)?.text ?? 'null'),
  }
}

/**
 * The world of a session that runs in Herdr's terminal t9.
 */
function inHerdr(on: On, stored: Record<string, unknown> = {}) {
  return world(on, [], stored, { HC_TERMINAL_ID: 't9' })
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

  test("a teammate's message to this session is no peer message", async ($, on) => {
    world(on)

    await $.session.start(SESSION)
    expect(await $.session.receive(FROM_TEAMMATE), 'passed on as it came').toEqual({
      text: FROM_TEAMMATE.text,
    })
    await $.command.run(CROSSTALK)

    const drawn = textOf(await $.ui.render(PANE))

    expect(drawn).not.toContain('idle_notification')
    expect(drawn).not.toContain('unknown session')
  })

  test('a send to a teammate is no peer message either', async ($, on) => {
    world(on)

    await $.session.start(SESSION)
    await $.tool.call({ tool: 'SendMessage', to: 'alpha', message: '[demo] main-to-agent ping' })
    await $.command.run(CROSSTALK)

    const ui = await $.ui.mount({ plugin: 'crosstalk', ...PANE, surface: 'terminal' as const })

    expect(
      (await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => k?.startsWith('open:')),
    ).toEqual(['open:api', 'open:web'])
  })

  test("a delivery for one of this session's agents is not its own conversation", async ($, on) => {
    world(on)

    await $.session.start(SESSION)

    const forAgent = { ...fromPeer('api', 'for your subagent'), agentId: 'a4f662925677a1908' }

    expect(await $.session.receive(forAgent), 'passed on as it came').toEqual({
      text: forAgent.text,
    })
    await $.command.run(CROSSTALK)

    expect(textOf(await $.ui.render(PANE))).not.toContain('for your subagent')
  })

  test("an unplaced pane says why, in the engine's words", async ($, on) => {
    const w = world(on)

    w.open.result = { isPlaced: false, reason: 'the reason the engine gives' }
    await $.session.start(SESSION)

    expect(await $.command.run(CROSSTALK)).toEqual({
      text: 'crosstalk is open: the reason the engine gives',
    })
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
      "not sent: Not sent — no agent named 'gone' is reachable.",
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

describe('herdr', () => {
  test('outside Herdr, crosstalk writes no file, polls none, lists no peer', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'ready?'))
    await w.clock.advance(REFRESH_MS * 2)

    expect(w.fsCalls).toEqual([])
    expect(w.listings, 'the pane closed, no ListAgents').toEqual([])
  })

  test("a headless session started from Herdr's terminal leaves Herdr's files alone", async ($, on) => {
    const w = inHerdr(on)

    w.outbox({ v: 1, send: [{ id: 'h1', to: 'api', text: 'not from claude -p' }] })
    await $.session.start({ ...SESSION, isInteractive: false })
    await w.clock.advance(REFRESH_MS)

    expect(w.fsCalls).toEqual([])
    expect(w.listings).toEqual([])
    expect(w.sent).toEqual([])
  })

  test('an outbox written for another session sends nothing', async ($, on) => {
    const w = inHerdr(on)

    await $.session.start(SESSION)
    w.outbox({ v: 1, session: 's0', send: [{ id: 'h1', to: 'api', text: 'for s0' }] })
    await w.clock.advance(OUTBOX_MS)

    expect(w.sent).toEqual([])
    expect(w.published().handled).toEqual({})
  })

  test('a publication whose move failed is written again', async ($, on) => {
    const w = inHerdr(on)

    await $.session.start(SESSION)
    await w.clock.settle()
    w.mv.exitCode = 1
    await $.session.receive(fromPeer('api', 'ready?'))
    await w.clock.settle()

    expect(w.published().threads, 'the move failed: the old file').toEqual({})

    w.mv.exitCode = 0
    await w.clock.advance(REFRESH_MS)

    expect(w.published().threads.api?.map(m => m.text)).toEqual(['ready?'])
  })

  test('an outbox longer than the ids kept still sends each entry once', async ($, on) => {
    const w = inHerdr(on)
    const send = Array.from({ length: Thread.MAX_HANDLED + 5 }, (_, i) => ({
      id: `h${i}`,
      to: 'api',
      text: `m${i}`,
    }))

    await $.session.start(SESSION)
    w.outbox({ v: 1, send })
    await w.clock.advance(OUTBOX_MS)
    w.outbox({ v: 1, send })
    await w.clock.advance(OUTBOX_MS)

    expect(w.sent).toHaveLength(send.length)
  })

  test('an outbox that could not be read is read again, unchanged', async ($, on) => {
    const w = inHerdr(on)

    await $.session.start(SESSION)
    w.reads.failing = 1
    w.outbox({ v: 1, send: [{ id: 'h1', to: 'api', text: 'hi' }] })
    await w.clock.advance(OUTBOX_MS)

    expect(w.sent).toEqual([])

    await w.clock.advance(OUTBOX_MS)

    expect(w.sent).toHaveLength(1)
  })

  test('one look at the outbox at a time: a slow read never sends twice', async ($, on) => {
    const w = inHerdr(on)
    let release = () => {}

    await $.session.start(SESSION)
    w.reads.held = new Promise(resolve => {
      release = resolve
    })
    w.outbox({ v: 1, send: [{ id: 'h1', to: 'api', text: 'hi' }] })
    await w.clock.advance(OUTBOX_MS)
    await w.clock.advance(OUTBOX_MS)
    w.reads.held = undefined
    release()
    await w.clock.settle()

    expect(w.sent).toHaveLength(1)
  })

  test('a reply from Herdr keeps the reader where they scrolled back to', async ($, on) => {
    const w = inHerdr(on)

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
    await ui.press({ key: 'older' })
    w.outbox({ v: 1, send: [{ id: 'h1', to: 'api', text: 'from herdr' }] })
    await w.clock.advance(OUTBOX_MS)
    await ui.redraw()

    expect(w.sent).toHaveLength(1)
    expect(textOf(await ui.drawn()), 'still scrolled back').not.toContain('from herdr')
  })

  test('publications land in order: a slow write never leaves an older one last', async ($, on) => {
    const w = inHerdr(on)
    let release = () => {}

    await $.session.start(SESSION)
    await w.clock.settle()
    w.writes.holdNext = new Promise(resolve => {
      release = resolve
    })
    await $.session.receive(fromPeer('api', 'one'))
    await $.session.receive(fromPeer('api', 'two'))
    release()
    await w.clock.settle()

    expect(w.published().threads.api?.map(m => m.text)).toEqual(['one', 'two'])
  })

  test('a peer message landing while Herdr sends keeps what the send recorded', async ($, on) => {
    const w = inHerdr(on)
    let release = () => {}

    await $.session.start(SESSION)
    w.nowHold.next = new Promise(resolve => {
      release = resolve
    })

    const receiving = $.session.receive(fromPeer('api', 'ping'))

    w.outbox({ v: 1, send: [{ id: 'h1', to: 'api', text: 'from herdr' }] })
    await w.clock.advance(OUTBOX_MS)

    expect(w.sent, 'Herdr sent while the delivery waited on the clock').toHaveLength(1)

    release()
    await receiving
    await w.clock.settle()

    expect(w.published().handled).toEqual({ h1: { status: 'sent', at: OUTBOX_MS } })
    expect(
      w
        .published()
        .threads.api?.map(m => m.text)
        .sort(),
    ).toEqual(['from herdr', 'ping'])
  })

  test("the model's send landing while Herdr sends keeps what the send recorded", async ($, on) => {
    const w = inHerdr(on)
    let release = () => {}

    await $.session.start(SESSION)
    w.nowHold.next = new Promise(resolve => {
      release = resolve
    })

    const sending = $.tool.call({ tool: 'SendMessage', to: 'web', message: 'from the model' })

    w.outbox({ v: 1, send: [{ id: 'h1', to: 'api', text: 'from herdr' }] })
    await w.clock.advance(OUTBOX_MS)

    expect(w.sent, 'Herdr sent while the model send waited on the clock').toHaveLength(2)

    release()
    await sending
    await w.clock.settle()

    expect(w.published().handled).toEqual({ h1: { status: 'sent', at: OUTBOX_MS } })
    expect(w.published().threads.web?.map(m => m.text)).toEqual(['from the model'])
  })

  test('nothing goes out unless its id was saved first', async ($, on) => {
    const w = inHerdr(on)

    await $.session.start(SESSION)
    w.saves.isFull = true
    w.outbox({ v: 1, send: [{ id: 'h1', to: 'api', text: 'hi' }] })
    await w.clock.advance(OUTBOX_MS)

    expect(w.sent).toEqual([])
    expect(w.published().handled).toEqual({
      h1: { status: 'refused', reason: Thread.UNSAVED, at: OUTBOX_MS },
    })
  })

  test('an unchanged outbox is not read again', async ($, on) => {
    const w = inHerdr(on)

    await $.session.start(SESSION)
    w.outbox({ v: 1, send: [{ id: 'h1', to: 'api', text: 'hi' }] })
    await w.clock.advance(OUTBOX_MS * 4)

    expect(w.fsCalls.filter(call => call === `read ${OUTBOX}`)).toHaveLength(1)
  })

  test('a second start looks at the outbox once a period still', async ($, on) => {
    const w = inHerdr(on)

    await $.session.start(SESSION)
    await $.session.start(SESSION)
    w.fsCalls.length = 0
    await w.clock.advance(OUTBOX_MS * 3)

    expect(w.fsCalls.filter(call => call.startsWith('stat'))).toHaveLength(3)
  })

  test('in Herdr, the conversations are published as they change, whole files only', async ($, on) => {
    const w = inHerdr(on)

    await $.session.start(SESSION)
    await w.clock.settle()

    expect(w.published().session, 'named by the listing taken at the start').toEqual({
      id: 's1',
      name: 'claude-98',
      terminal: 't9',
      cwd: '/work',
      project: 'api',
    })
    expect(
      w.published().peers.map(p => p.name),
      'every listed session',
    ).toEqual(['api', 'web', 'laptop-bubble', 'ultrareview: HEAD'])

    await w.clock.advance(1000)
    await $.session.receive(fromPeer('api', '**ready?**'))
    await w.clock.settle()

    const published = w.published()

    expect(published.updatedAt).toBe(1000)
    expect(published.peers[0]).toEqual({
      key: 'api',
      title: 'api',
      name: 'api',
      address: 'api',
      kind: 'interactive',
      status: 'idle',
      live: true,
      lastMessageAt: 1000,
      unread: 1,
      last: { dir: 'in', text: '**ready?**', at: 1000 },
    })
    expect(published.threads).toEqual({ api: [{ dir: 'in', text: '**ready?**', at: 1000 }] })
    expect([...w.files.keys()], 'written beside, then moved over').toEqual([PUBLICATION])
    expect(w.runs.at(-1)).toEqual(['mv', '-f', `${PUBLICATION}.tmp`, PUBLICATION])

    const writes = () => w.fsCalls.filter(call => call.startsWith('write')).length
    const before = writes()

    await w.clock.advance(REFRESH_MS)

    expect(writes(), 'nothing new, nothing written').toBe(before)
  })

  test("a message from Herdr goes out once, as the pane's reply does, and is answered", async ($, on) => {
    const w = inHerdr(on)

    await $.session.start(SESSION)
    w.outbox({ v: 1, send: [{ id: 'h1', to: 'api', text: 'from herdr', at: 0 }] })
    await w.clock.advance(OUTBOX_MS)

    expect(w.sent.map(e => [Reflect.get(e, 'to'), Reflect.get(e, 'message')])).toEqual([
      ['api', 'from herdr'],
    ])
    expect(w.storedAtSend[0], 'saved as handled before it went').toMatchObject({
      handled: { h1: { status: 'pending' } },
    })
    expect(w.published().handled).toEqual({ h1: { status: 'sent', at: OUTBOX_MS } })
    expect(w.published().threads.api).toEqual([
      { dir: 'out', text: 'from herdr', at: OUTBOX_MS, id: 'h1' },
    ])

    w.outbox({ v: 1, send: [{ id: 'h1', to: 'api', text: 'from herdr', at: 0 }] })
    await w.clock.advance(OUTBOX_MS)

    expect(w.sent, 'the same id is never sent twice').toHaveLength(1)
  })

  test('an id a reload cut off mid-send is not sent again', async ($, on) => {
    const pending = Thread.withHandled(Thread.EMPTY, 'h1', { status: 'pending', at: 1 })
    const w = inHerdr(on, { 'thread:s1': Thread.toSaved(pending, 1) })

    await $.session.start(SESSION)
    w.outbox({ v: 1, send: [{ id: 'h1', to: 'api', text: 'again?' }] })
    await w.clock.advance(OUTBOX_MS)

    expect(w.sent).toEqual([])
    expect(w.published().handled).toEqual({
      h1: { status: 'refused', reason: Thread.INTERRUPTED, at: 1 },
    })
  })

  test('Herdr cannot write to a stranger nor send nothing; a refused send is not drawn', async ($, on) => {
    const w = inHerdr(on)

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('gone', 'still here?'))
    w.outbox({
      v: 1,
      send: [
        { id: 'h1', to: 'nobody', text: 'hi' },
        { id: 'h2', to: 'api', text: '  ' },
        { id: 'h3', to: 'gone', text: 'you there?' },
      ],
    })
    await w.clock.advance(OUTBOX_MS)

    expect(w.sent.map(e => Reflect.get(e, 'to'))).toEqual(['gone'])
    expect(w.published().handled).toEqual({
      h1: { status: 'refused', reason: 'unknown peer: nobody', at: OUTBOX_MS },
      h2: { status: 'refused', reason: 'empty message', at: OUTBOX_MS },
      h3: {
        status: 'refused',
        reason: "Not sent — no agent named 'gone' is reachable.",
        at: OUTBOX_MS,
      },
    })
    expect(w.published().threads.gone).toEqual([{ dir: 'in', text: 'still here?', at: 0 }])
  })

  test("Herdr's read marks clear what it read; the status line agrees", async ($, on) => {
    const w = inHerdr(on)

    await $.session.start(SESSION)
    await w.clock.set(1000)
    await $.session.receive(fromPeer('api', 'one'))
    await w.clock.set(2000)
    await $.session.receive(fromPeer('api', 'two'))

    expect(w.statuses.at(-1)).toBe('crosstalk · 2 unread')

    w.outbox({ v: 1, send: [], read: { api: 1000 } })
    await w.clock.advance(OUTBOX_MS)

    expect(w.statuses.at(-1)).toBe('crosstalk · 1 unread')
    expect(w.published().peers[0]?.unread).toBe(1)
  })

  test('in Herdr, peers are listed on the interval, pane open or not', async ($, on) => {
    const w = inHerdr(on)

    on('ui.close', () => ({ value: undefined }))
    await $.session.start(SESSION)
    await $.command.run(CROSSTALK)
    await $.command.run(CROSSTALK)

    const before = w.listings.length

    await w.clock.advance(REFRESH_MS)

    expect(w.listings).toHaveLength(before + 1)
  })
})

// The session another Herdr terminal (t3) publishes, listed here as `api`,
// and its claude-flow file. Session ids are UUIDs, as Claude Code's are.
const API_ID = '435240f6-183d-456f-84ce-af986698e725'
const NEW_ID = '6fa2dabb-6acf-4bb4-ae9b-e668e0dfbbd8'
const API_SESSION = {
  v: 2,
  session: { id: API_ID, name: 'api', terminal: 't3', project: 'api-repo' },
  peers: [],
  threads: {},
  handled: {},
}
const API_FLOW = {
  v: 1,
  workflow: 'me:issue-worktree-pr',
  steps: [{ id: 'issue', label: 'issue #61', state: 'done' }],
}

describe('names', () => {
  test('in Herdr, a peer another terminal publishes is filed under its session id', async ($, on) => {
    const w = inHerdr(on)

    w.herdrFile('t3.crosstalk.json', API_SESSION)
    w.herdrFile('t3.flow.json', API_FLOW)
    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'ready?'))
    await w.clock.settle()

    expect(w.published().peers.find(peer => peer.name === 'api')).toMatchObject({
      key: API_ID,
      sessionId: API_ID,
      title: 'api-repo · #61',
      project: 'api-repo',
      topic: '#61',
      live: true,
    })
    expect(w.published().threads[API_ID]?.map(m => m.text)).toEqual(['ready?'])

    w.outbox({ v: 2, send: [{ id: 'h1', to: API_ID, text: 'yes' }] })
    await w.clock.advance(OUTBOX_MS)

    expect(
      w.sent.map(e => Reflect.get(e, 'to')),
      'a reply goes to its live name',
    ).toEqual(['api'])
  })

  test('a peer restarted under a new name keeps its conversation', async ($, on) => {
    const w = inHerdr(on)

    w.herdrFile('t3.crosstalk.json', API_SESSION)
    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'before'))
    w.agents.listing = LISTING.replace('api [a1aa87]', 'api-1d [b2bb22]')
    w.herdrFile('t3.crosstalk.json', {
      ...API_SESSION,
      session: { ...API_SESSION.session, name: 'api-1d' },
    })
    await w.clock.advance(REFRESH_MS)
    await $.session.receive(fromPeer('api-1d', 'after'))
    await w.clock.settle()

    expect(Object.keys(w.published().threads)).toEqual([API_ID])
    expect(w.published().threads[API_ID]?.map(m => m.text)).toEqual(['before', 'after'])
  })

  test("other terminals' files are read again only once changed, never this one's", async ($, on) => {
    const w = inHerdr(on)

    w.herdrFile('t3.crosstalk.json', API_SESSION)
    await $.session.start(SESSION)
    await w.clock.advance(REFRESH_MS * 2)

    expect(w.fsCalls.filter(call => call === `read ${HERDR}/t3.crosstalk.json`)).toHaveLength(1)
    expect(w.fsCalls).not.toContain(`read ${PUBLICATION}`)
  })

  test('a hand-written file whose id is no session id is not believed', async ($, on) => {
    const w = inHerdr(on)

    w.herdrFile('t3.crosstalk.json', API_SESSION)
    w.herdrFile('t-fixture.crosstalk.json', {
      ...API_SESSION,
      session: { ...API_SESSION.session, id: 'xtfix-session-2', terminal: 't-fixture' },
    })
    await $.session.start(SESSION)
    await w.clock.settle()

    expect(w.published().peers.find(peer => peer.name === 'api')?.key).toBe(API_ID)
  })

  test('when two terminals claim one name, the newest file says who it is', async ($, on) => {
    const w = inHerdr(on)

    w.herdrFile('t3.crosstalk.json', API_SESSION)
    w.herdrFile('t4.crosstalk.json', {
      ...API_SESSION,
      session: { ...API_SESSION.session, id: NEW_ID, terminal: 't4' },
    })
    await $.session.start(SESSION)
    await w.clock.settle()

    expect(w.published().peers.find(peer => peer.name === 'api')?.key).toBe(NEW_ID)
  })

  test('a title from Herdr is kept in the shared store and published; empty, it clears', async ($, on) => {
    const w = inHerdr(on, { titles: { 'S-other': 'kept' } })
    const titleOf = () => w.published().peers.find(peer => peer.key === 'api')?.title

    await $.session.start(SESSION)
    w.outbox({ v: 2, title: { api: 'API backend' } })
    await w.clock.advance(OUTBOX_MS)

    expect(w.store.get('titles'), "another session's title kept").toEqual({
      'S-other': 'kept',
      api: 'API backend',
    })
    expect(titleOf()).toBe('API backend')

    w.outbox({ v: 2, title: { api: '' } })
    await w.clock.advance(OUTBOX_MS)

    expect(w.store.get('titles')).toEqual({ 'S-other': 'kept' })
    expect(titleOf()).toBe('api')
  })

  test('a title another session gave shows here, at the next listing too', async ($, on) => {
    const w = inHerdr(on, { titles: { api: 'from elsewhere' } })
    const titleOf = () => w.published().peers.find(peer => peer.key === 'api')?.title

    await $.session.start(SESSION)
    await w.clock.settle()

    expect(titleOf()).toBe('from elsewhere')

    w.store.set('titles', { api: 'renamed elsewhere' })
    await w.clock.advance(REFRESH_MS)

    expect(titleOf()).toBe('renamed elsewhere')
  })

  test('a conversation that resolves takes its title along, in the store too', async ($, on) => {
    const w = inHerdr(on, { titles: { api: 'API backend' } })

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'ready?'))
    w.herdrFile('t3.crosstalk.json', API_SESSION)
    await w.clock.advance(REFRESH_MS)

    expect(w.store.get('titles')).toEqual({ [API_ID]: 'API backend' })
    expect(w.published().peers.find(peer => peer.name === 'api')).toMatchObject({
      key: API_ID,
      title: 'API backend',
    })
  })

  test('a message landing while a moved title is stored is kept', async ($, on) => {
    const w = inHerdr(on, { titles: { api: 'API backend' } })
    let release = () => {}

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'before'))
    w.herdrFile('t3.crosstalk.json', API_SESSION)
    w.saves.holdTitles = new Promise(resolve => {
      release = resolve
    })
    await w.clock.advance(REFRESH_MS)
    await $.session.receive(fromPeer('api', 'during'))
    w.saves.holdTitles = undefined
    release()
    await w.clock.settle()

    expect(w.published().threads[API_ID]?.map(m => m.text)).toEqual(['before', 'during'])
    expect(w.store.get('titles')).toEqual({ [API_ID]: 'API backend' })
  })

  test('titles that could not be read are not written over; the outbox is read again', async ($, on) => {
    const w = inHerdr(on, { titles: { 'S-other': 'kept' } })

    await $.session.start(SESSION)
    w.saves.titleReadsFailing = 1
    w.outbox({ v: 2, title: { api: 'API backend' } })
    await w.clock.advance(OUTBOX_MS)

    expect(w.store.get('titles'), "another session's titles intact").toEqual({ 'S-other': 'kept' })

    await w.clock.advance(OUTBOX_MS)

    expect(w.store.get('titles')).toEqual({ 'S-other': 'kept', api: 'API backend' })
  })

  test('Herdr may name a resolved peer: to, read and title by name reach its id', async ($, on) => {
    const w = inHerdr(on)

    w.herdrFile('t3.crosstalk.json', API_SESSION)
    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'one'))
    w.outbox({ v: 1, send: [{ id: 'h1', to: 'api', text: 'by name' }], read: { api: 0 } })
    await w.clock.advance(OUTBOX_MS)

    expect(w.sent.map(e => Reflect.get(e, 'to'))).toEqual(['api'])
    expect(w.published().threads[API_ID]?.map(m => m.text)).toEqual(['one', 'by name'])
    expect(w.published().peers.find(peer => peer.key === API_ID)?.unread).toBe(0)

    w.outbox({ v: 2, title: { api: 'API backend' } })
    await w.clock.advance(OUTBOX_MS)

    expect(w.store.get('titles')).toEqual({ [API_ID]: 'API backend' })
  })

  test('Herdr may write to any session the publication lists, talked to or not', async ($, on) => {
    const w = inHerdr(on)

    await $.session.start(SESSION)
    w.outbox({ v: 2, send: [{ id: 'h1', to: 'laptop-bubble', text: 'hi' }] })
    await w.clock.advance(OUTBOX_MS)

    expect(w.sent.map(e => Reflect.get(e, 'to'))).toEqual(['laptop-bubble'])
  })

  test('a draft moves with its conversation when it resolves', async ($, on) => {
    const w = inHerdr(on)

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'ready?'))
    await $.command.run(CROSSTALK)

    const ui = await $.ui.mount({ plugin: 'crosstalk', ...PANE, surface: 'terminal' as const })

    await ui.press({ key: 'open:api' })
    await ui.redraw()
    await ui.input({ key: 'reply', text: 'half a thought', kind: 'change' })
    w.herdrFile('t3.crosstalk.json', API_SESSION)
    await w.clock.advance(REFRESH_MS)
    await ui.redraw()

    expect((await ui.find({ key: 'reply' }))?.props.value).toBe('half a thought')
  })

  test("Herdr's title applies once, when it appears or changes, not at each read", async ($, on) => {
    const w = inHerdr(on)

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'hi'))
    w.outbox({ v: 2, title: { api: 'A' } })
    await w.clock.advance(OUTBOX_MS)

    expect(w.store.get('titles')).toEqual({ api: 'A' })

    // Renamed since, from another session (or with r).
    w.store.set('titles', { api: 'B' })
    await w.clock.advance(REFRESH_MS)
    w.outbox({ v: 2, title: { api: 'A' }, read: { api: 0 } })
    await w.clock.advance(OUTBOX_MS)

    expect(w.store.get('titles'), 'the same title read again undoes nothing').toEqual({
      api: 'B',
    })

    w.outbox({ v: 2, title: { api: 'C' } })
    await w.clock.advance(OUTBOX_MS)

    expect(w.store.get('titles')).toEqual({ api: 'C' })
  })

  test("a title Herdr's outbox already gave is not given again after a reload", async ($, on) => {
    const saved = Thread.toSaved({ ...Thread.EMPTY, fromOutbox: { api: 'A' } }, 1)
    const w = inHerdr(on, { 'thread:s1': saved, titles: { api: 'B' } })

    await $.session.start(SESSION)
    w.outbox({ v: 2, title: { api: 'A' } })
    await w.clock.advance(OUTBOX_MS)

    expect(w.store.get('titles')).toEqual({ api: 'B' })
  })

  test('a title for no published peer is not stored', async ($, on) => {
    const w = inHerdr(on)

    await $.session.start(SESSION)
    w.outbox({ v: 2, title: { nobody: 'X' } })
    await w.clock.advance(OUTBOX_MS)

    expect(w.store.get('titles')).toBeUndefined()
  })

  test('a peer renamed at the same socket takes its stored title along', async ($, on) => {
    const w = world(on, [], { titles: { 'api-3e': 'API backend' } })
    const from = (name: string, text: string) => ({
      origin: { kind: 'peer' as const },
      text: `<cross-session-message from="uds:/tmp/1.sock" from-name="${name}">${text}</cross-session-message>`,
    })

    await $.session.start(SESSION)
    await $.session.receive(from('api-3e', 'one'))
    await $.session.receive(from('api-v2', 'two'))
    await w.clock.settle()

    expect(w.store.get('titles')).toEqual({ 'api-v2': 'API backend' })
  })
})
