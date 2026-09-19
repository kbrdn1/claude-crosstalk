import { describe, expect, test } from 'claude-code/testing'

import type { Entry } from '../hooks/thread'
import * as Thread from '../hooks/thread'
import * as View from '../hooks/view'
import { AT, textOf } from './fixtures'

const at = (hhmm: string, day = '19') => AT(`2026-09-${day}T${hhmm}:00.000`)

describe('view', () => {
  test('an inbox row previews the last message, yours marked, first line only', async () => {
    expect(View.previewOf(undefined, 40)).toBe('no message yet')
    expect(View.previewOf({ dir: 'in', peer: 'api', text: 'tests are green\nand more' }, 40)).toBe(
      'tests are green',
    )
    expect(View.previewOf({ dir: 'out', peer: 'api', text: 'ship it' }, 40)).toBe('you: ship it')
    expect(View.previewOf({ dir: 'in', peer: 'api', text: 'x'.repeat(60) }, 20)).toHaveLength(20)
  })

  test('a name keeps both ends when it has to be cut, whole when it fits', async () => {
    expect(View.fitName('test-655-fmt-clippy-guards', 40)).toBe('test-655-fmt-clippy-guards')
    expect(View.fitName('claude-98', 6)).not.toBe(View.fitName('claude-9f', 6))
    expect(View.fitName('test-655-fmt-clippy-guards', 12)).toHaveLength(12)
  })

  test('a burst from one side is one group; a new day, a side or a pause starts another', async () => {
    const entries: Entry[] = [
      { dir: 'in', peer: 'api', text: 'a', at: at('23:58', '18') },
      { dir: 'in', peer: 'api', text: 'b', at: at('00:01') },
      { dir: 'in', peer: 'api', text: 'c', at: at('00:03') },
      { dir: 'out', peer: 'api', text: 'd', at: at('00:04') },
      { dir: 'out', peer: 'api', text: 'e', at: at('00:20') },
    ]

    expect(
      View.groupsOf(entries).map(g => [g.dir, g.day, g.entries.map(e => e.text).join('')]),
    ).toEqual([
      ['in', 'fri 18 sep', 'a'],
      ['in', 'sat 19 sep', 'bc'],
      ['out', undefined, 'd'],
      ['out', undefined, 'e'],
    ])
  })

  test('messages without a time group by side alone, under no day', async () => {
    const entries: Entry[] = [
      { dir: 'in', peer: 'api', text: 'a' },
      { dir: 'in', peer: 'api', text: 'b' },
      { dir: 'out', peer: 'api', text: 'c' },
    ]

    expect(View.groupsOf(entries).map(g => [g.day, g.entries.length])).toEqual([
      [undefined, 2],
      [undefined, 1],
    ])
  })

  test('a text takes the rows its word-wrapped lines take', async () => {
    expect(View.rowsOf('short', 20)).toBe(1)
    expect(View.rowsOf('x'.repeat(45), 20), 'a word longer than the row breaks').toBe(3)
    expect(View.rowsOf('one\ntwo\n\nfour', 20)).toBe(4)
    expect(View.rowsOf('aaaa bbbb cccc dddd eeee', 10), 'words move whole').toBe(3)
  })

  test('your short message hugs the right edge, a long one takes the bubble', async () => {
    expect(View.widthOf('ok', 40)).toBe(2)
    expect(View.widthOf('one\nlonger line', 40)).toBe(11)
    expect(View.widthOf('x'.repeat(90), 40)).toBe(40)
  })

  test('the window ends on the newest message, and scrolling back shows older ones', async () => {
    const entries: Entry[] = Array.from({ length: 10 }, (_, i) => ({
      dir: 'in' as const,
      peer: 'api',
      text: `m${i}`,
    }))

    const bottom = View.windowOf(entries, 6, 0, 40)

    expect(bottom.entries.at(-1)?.text).toBe('m9')
    expect(bottom.newer).toBe(0)
    expect(bottom.earlier).toBe(10 - bottom.entries.length)

    const back = View.windowOf(entries, 6, 4, 40)

    expect(back.entries.at(-1)?.text).toBe('m5')
    expect(back.newer).toBe(4)
  })

  test('wide panes put your messages on the right, narrow ones stack both sides left', async () => {
    expect(View.layoutOf(80)).toMatchObject({ isSplit: true })
    expect(View.layoutOf(80).bubble).toBeLessThan(80)
    expect(View.layoutOf(40)).toMatchObject({ isSplit: false })
    expect(View.layoutOf(200).bubble, 'a line stays readable on a wide inline pane').toBe(72)
  })

  test('a rule spans the width, its label centred', async () => {
    expect(View.ruleOf(20)).toBe('─'.repeat(20))
    expect(View.ruleOf(20, 'sat 19 sep')).toHaveLength(20)
    expect(View.ruleOf(20, 'sat 19 sep')).toBe('──── sat 19 sep ────')
  })

  test('the day label reads as a short date', async () => {
    expect(View.dayOf(at('12:00'))).toBe('sat 19 sep')
  })
})

/**
 * Element constructors that build the tree as plain data, so a view renders
 * without an engine: `{ type, props, children }`, a Button's closures kept.
 */
const FAKE_UI = Object.fromEntries(
  ['Box', 'Text', 'Button', 'Input', 'Markdown'].map(type => [
    type,
    (props: Record<string, unknown>) => ({ type, props, children: props.children }),
  ]),
) as unknown as View.Kit['ui']

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown }

function buttonsOf(tree: unknown): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(buttonsOf)
  if (typeof tree !== 'object' || tree === null) return []

  const node = tree as Node

  return [...(node.type === 'Button' ? [node] : []), ...buttonsOf(node.children)]
}

function kitOf(overrides: Partial<View.Kit> = {}) {
  const calls: string[] = []
  const kit: View.Kit = {
    ui: FAKE_UI,
    columns: 60,
    rows: 30,
    isFocused: true,
    back: 0,
    draft: '',
    view: 'inbox',
    mode: 'insert',
    home: 'open:api',
    onOpen: peer => calls.push(`open ${peer}`),
    onInbox: () => calls.push('inbox'),
    onBack: by => calls.push(`back ${by}`),
    onInput: () => undefined,
    onSubmit: () => undefined,
    onMove: delta => calls.push(`move ${delta}`),
    onOpenHere: () => calls.push('open here'),
    onTop: () => calls.push('top'),
    onInsert: () => calls.push('insert'),
    onClose: () => calls.push('close'),
    ...overrides,
  }

  return { kit, calls }
}

const THREAD = Thread.record(
  Thread.record(Thread.record(Thread.EMPTY, { dir: 'in', peer: 'web', text: 'deployed', at: 2 }), {
    dir: 'in',
    peer: 'api',
    text: 'ready?',
    at: 3,
  }),
  { dir: 'out', peer: 'api', text: 'yes', at: 4 },
)

const press = (tree: unknown, hotkey: string) => {
  const button = buttonsOf(tree).find(b => b.props?.hotkey === hotkey)
  const onPress = button?.props?.onPress

  if (typeof onPress !== 'function') throw new Error(`no ${hotkey} key`)

  onPress()
}

describe('vim keys', () => {
  test('the inbox binds j k l g q to move, open, go to the top and close', async () => {
    const { kit, calls } = kitOf()
    const tree = View.paneView(kit, THREAD)

    expect(buttonsOf(tree).flatMap(b => (b.props?.hotkey ? [b.props.hotkey] : []))).toEqual([
      'j',
      'k',
      'l',
      'g',
      'q',
    ])

    press(tree, 'j')
    press(tree, 'k')
    press(tree, 'l')
    press(tree, 'g')
    press(tree, 'q')

    expect(calls).toEqual(['move 1', 'move -1', 'open here', 'top', 'close'])
  })

  test('the ring starts on home: a row, the reply field, or ‹ in normal mode', async () => {
    const focusedOf = (tree: unknown) =>
      buttonsOf(tree).find(b => b.props?.autoFocus)?.props?.key ?? 'none'

    expect(focusedOf(View.paneView(kitOf({ home: 'open:web' }).kit, THREAD))).toBe('open:web')
    expect(
      focusedOf(
        View.paneView(kitOf({ view: 'thread', mode: 'normal', home: 'back' }).kit, {
          ...THREAD,
          selected: 'api',
        }),
      ),
    ).toBe('back')
  })

  test('a conversation in insert mode binds no letter: they are typed', async () => {
    const { kit } = kitOf({ view: 'thread', mode: 'insert' })
    const tree = View.paneView(kit, { ...THREAD, selected: 'api' })

    expect(buttonsOf(tree).filter(b => b.props?.hotkey)).toEqual([])
    expect(textOf(tree)).toContain('esc normal')
  })

  test('normal mode binds j k d u g i h q to scroll, reply, go back and close', async () => {
    const { kit, calls } = kitOf({ view: 'thread', mode: 'normal', home: 'back' })
    const tree = View.paneView(kit, { ...THREAD, selected: 'api' })

    for (const key of ['j', 'k', 'd', 'u', 'g', 'i', 'h', 'q']) {
      press(tree, key)
    }

    expect(calls).toEqual([
      'back -1',
      'back 1',
      'back -1',
      'back 1',
      'back -2',
      'insert',
      'inbox',
      'close',
    ])
  })

  test('the next row stops at the ends and starts from the top off a row', async () => {
    const rows = ['open:a', 'open:b', 'open:c']

    expect(View.rowAfter(rows, 'open:b', 1)).toBe('open:c')
    expect(View.rowAfter(rows, 'open:c', 1)).toBe('open:c')
    expect(View.rowAfter(rows, 'open:a', -1)).toBe('open:a')
    expect(View.rowAfter(rows, 'vim:j', 1)).toBe('open:a')
    expect(View.rowAfter([], undefined, 1)).toBeUndefined()
  })
})
