import type { On, ToolCallInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { CROSSTALK, fromPeer, LISTING, PANE, SESSION, textOf } from './fixtures'

/**
 * The world beneath crosstalk: a clock, ListAgents answering LISTING,
 * SendMessage answering sent and remembering every call, panes opening.
 */
function world(on: On) {
  const sent: ToolCallInput[] = []
  const opened: string[] = []
  const statuses: (string | undefined)[] = []

  const clock = mock.clock(on)

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.receive', ($, e) => ({ text: e.text }))

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

  return { sent, opened, statuses, clock }
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

  test('a message arriving while the pane is closed shows as unread', async ($, on) => {
    const w = world(on)

    await $.session.start(SESSION)
    await $.session.receive(fromPeer('api', 'ping'))

    expect(w.statuses.at(-1)).toBe('crosstalk · 1 unread')
  })
})
