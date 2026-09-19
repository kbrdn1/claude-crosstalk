import { describe, expect, test } from 'claude-code/testing'

import type { Conversation, Entry } from '../hooks/thread'
import * as View from '../hooks/view'
import { AT } from './fixtures'

const CONVERSATIONS: Conversation[] = [
  { peer: 'claude-crosstalk-b2', status: 'idle', unread: 0 },
  { peer: 'test-655-fmt-clippy-guards', status: 'idle', unread: 3 },
  { peer: 'crimson-desert-start', status: 'busy', unread: 0 },
]

const at = (hhmm: string, day = '19') => AT(`2026-09-${day}T${hhmm}:00.000`)

describe('view', () => {
  test('tabs fit the width, numbered, the selected one flagged, unread counted', async () => {
    const { tabs, hidden } = View.tabsOf(CONVERSATIONS, 'test-655-fmt-clippy-guards', 80)

    expect(hidden).toBe(0)
    expect(tabs.map(t => [t.hotkey, t.isSelected])).toEqual([
      ['1', false],
      ['2', true],
      ['3', false],
    ])
    expect(tabs[1]?.label).toMatch(/·3$/)
    expect(View.tabsWidthOf(tabs, hidden)).toBeLessThanOrEqual(80)
  })

  test('narrow tabs truncate names, then hide the rest, never the selected', async () => {
    const narrow = View.tabsOf(CONVERSATIONS, 'claude-crosstalk-b2', 44)

    expect(narrow.hidden).toBe(0)
    expect(narrow.tabs.some(t => t.label.includes('…'))).toBe(true)

    const alike = View.tabsOf(
      ['claude-98', 'claude-9f', 'claude-crosstalk'].map(peer => ({ peer, unread: 0 })),
      'claude-98',
      30,
    )
    const labels = alike.tabs.map(t => t.label)

    expect(new Set(labels).size, `names alike stay apart once cut: ${labels.join(' ')}`).toBe(labels.length)
    expect(View.tabsWidthOf(narrow.tabs, narrow.hidden)).toBeLessThanOrEqual(44)

    const tiny = View.tabsOf(CONVERSATIONS, 'crimson-desert-start', 24)

    expect(tiny.hidden).toBeGreaterThan(0)
    expect(tiny.tabs.some(t => t.isSelected && t.peer === 'crimson-desert-start')).toBe(true)
    expect(View.tabsWidthOf(tiny.tabs, tiny.hidden)).toBeLessThanOrEqual(24)
  })

  test('a burst from one side is one group; a new day, a side or a pause starts another', async () => {
    const entries: Entry[] = [
      { dir: 'in', peer: 'api', text: 'a', at: at('23:58', '18') },
      { dir: 'in', peer: 'api', text: 'b', at: at('00:01') },
      { dir: 'in', peer: 'api', text: 'c', at: at('00:03') },
      { dir: 'out', peer: 'api', text: 'd', at: at('00:04') },
      { dir: 'out', peer: 'api', text: 'e', at: at('00:20') },
    ]

    expect(View.groupsOf(entries).map(g => [g.dir, g.day, g.entries.map(e => e.text).join('')])).toEqual([
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
