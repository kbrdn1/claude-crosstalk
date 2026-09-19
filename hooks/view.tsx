/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type { Elements, RenderElement } from 'claude-code'

import * as Thread from './thread'

/**
 * Claude Dark: the accent for what this session says, blue for what a peer
 * says, green/yellow for a peer's status, grey for the chrome.
 */
export const COLORS = {
  accent: '#D4825D',
  peer: '#7AB8FF',
  idle: '#86E89A',
  busy: '#FFDF61',
  muted: '#999999',
  error: '#FF7A7A',
} as const

export type Kit = {
  ui: Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Input' | 'Markdown'>
  columns: number
  rows: number
  isFocused: boolean
  back: number
  draft: string
  notice?: string
  onSelect: (peer: string) => void
  onBack: (by: number) => void
  onInput: (text: string) => void
  onSubmit: (text: string) => void
}

export type Tab = {
  peer: string
  label: string
  hotkey: string
  isSelected: boolean
}

export type Group = {
  dir: Thread.Direction
  peer: string
  day?: string
  entries: Thread.Entry[]
}

// Header, tabs, two rules, reply field, hints.
const CHROME_ROWS = 6
// Below this many columns both sides stack on the left.
const SPLIT_MIN_COLUMNS = 56
// A bubble never gets wider: a line past this reads badly.
const MAX_BUBBLE = 72
// A pause longer than this starts a new group.
const GROUP_GAP_MS = 5 * 60_000
const MAX_TABS = 9
const TAB_GAP = 2
const MIN_LABEL = 6
const MAX_MARKDOWN = 10_000

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/**
 * `HH:MM` of a timestamp, in the session's local time.
 */
export function clockOf(at: number): string {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * `sat 19 sep` of a timestamp, in the session's local time.
 */
export function dayOf(at: number): string {
  const date = new Date(at)

  return `${DAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}

/**
 * `text` cut in its middle to `max` cells: session names share their start
 * (`claude-…`) and differ at their end, so both ends stay.
 */
function truncateMiddle(text: string, max: number): string {
  if (text.length <= max || max < 5) {
    return truncate(text, max)
  }

  const head = Math.ceil((max - 1) / 3)

  return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`
}

/**
 * How the pane lays out at `columns`: wide enough, your messages sit on the
 * right and a bubble takes four fifths of the row; narrower, both sides
 * stack on the left, full width. Never past MAX_BUBBLE.
 */
export function layoutOf(columns: number): { isSplit: boolean; bubble: number } {
  const isSplit = columns >= SPLIT_MIN_COLUMNS

  const bubble = isSplit ? Math.floor(columns * 0.8) : Math.max(8, columns - 2)

  return { isSplit, bubble: Math.min(MAX_BUBBLE, bubble) }
}

/**
 * The cells a row of tabs takes: `1: label` each, two apart, and `+N` for
 * the hidden ones.
 */
export function tabsWidthOf(tabs: readonly Tab[], hidden: number): number {
  const drawn = tabs.reduce((sum, tab) => sum + tab.hotkey.length + 2 + tab.label.length, 0)
  const gaps = Math.max(0, tabs.length - 1) * TAB_GAP
  const more = hidden > 0 ? TAB_GAP + `+${hidden}`.length : 0

  return drawn + gaps + more
}

/**
 * The tabs that fit `columns`: every conversation up to nine, names cut to
 * share the row, then the last ones hidden behind `+N` until each keeps
 * MIN_LABEL cells. The selected one stays in view.
 */
export function tabsOf(
  conversations: readonly Thread.Conversation[],
  selected: string | undefined,
  columns: number,
): { tabs: Tab[]; hidden: number } {
  const all = conversations.slice(0, MAX_TABS)

  for (let count = all.length; count > 0; count--) {
    const kept = all.slice(0, count)
    const chosen = kept.some(c => c.peer === selected)
      ? kept
      : [...kept.slice(0, -1), ...all.filter(c => c.peer === selected)]
    const hidden = conversations.length - chosen.length
    const more = hidden > 0 ? TAB_GAP + `+${hidden}`.length : 0
    const room = columns - more - (chosen.length - 1) * TAB_GAP - chosen.length * 3
    const share = Math.floor(room / chosen.length)

    if (share >= MIN_LABEL || count === 1) {
      const tabs = chosen.map((c, i) => {
        const badge = c.unread > 0 ? ` ·${c.unread}` : ''
        const label = `${truncateMiddle(c.peer, Math.max(1, share - badge.length))}${badge}`

        return { peer: c.peer, label, hotkey: String(i + 1), isSelected: c.peer === selected }
      })

      return { tabs, hidden }
    }
  }

  return { tabs: [], hidden: conversations.length }
}

/**
 * The messages grouped as a chat draws them: a burst from one side under one
 * header, a new group on a change of side, a pause over five minutes or a new
 * day; `day` set on the first group of each day.
 */
export function groupsOf(entries: readonly Thread.Entry[]): Group[] {
  const groups: Group[] = []
  let lastDay: string | undefined

  for (const entry of entries) {
    const last = groups.at(-1)
    const previous = last?.entries.at(-1)
    const day = entry.at === undefined ? undefined : dayOf(entry.at)
    const isNewDay = day !== undefined && day !== lastDay
    const isPause =
      entry.at !== undefined &&
      previous?.at !== undefined &&
      entry.at - previous.at > GROUP_GAP_MS
    const isSameSide = last !== undefined && last.dir === entry.dir && last.peer === entry.peer

    if (last !== undefined && isSameSide && !isNewDay && !isPause) {
      last.entries.push(entry)
    } else {
      groups.push(
        isNewDay
          ? { dir: entry.dir, peer: entry.peer, day, entries: [entry] }
          : { dir: entry.dir, peer: entry.peer, entries: [entry] },
      )
    }

    lastDay = day ?? lastDay
  }

  return groups
}

function wrappedRowsOf(line: string, width: number): number {
  let rows = 1
  let used = 0

  for (const word of line.split(' ')) {
    if (used > 0 && used + 1 + word.length <= width) {
      used += 1 + word.length
      continue
    }

    if (used > 0) {
      rows += 1
    }

    used = word.length

    while (used > width) {
      rows += 1
      used -= width
    }
  }

  return rows
}

/**
 * The rows `text` takes word-wrapped at `width`: what the bar beside a
 * message is as tall as, and what the thread window budgets.
 *
 * ponytail: wraps as plain text does; a Markdown body (a code fence, a list)
 * can take a row more or less. The thread box clips its top, so an estimate
 * off by a row costs a row of the oldest message.
 */
export function rowsOf(text: string, width: number): number {
  const cells = Math.max(1, width)

  return text.split('\n').reduce((sum, line) => sum + wrappedRowsOf(line, cells), 0)
}

/**
 * The cells a message needs, up to `width`: a short one hugs its side.
 */
export function widthOf(text: string, width: number): number {
  const longest = Math.max(1, ...text.split('\n').map(line => line.length))

  return Math.min(Math.max(1, width), longest)
}

/**
 * The messages the thread shows in `rows`: the newest ones back from `back`
 * messages before the end, as many as fit (a header and a gap counted per
 * message), and how many are left above and below.
 */
export function windowOf(
  entries: readonly Thread.Entry[],
  rows: number,
  back: number,
  width: number,
): { entries: Thread.Entry[]; earlier: number; newer: number } {
  const newer = Math.min(Math.max(0, back), Math.max(0, entries.length - 1))
  const end = entries.length - newer
  let start = end
  let used = 0

  while (start > 0) {
    const cost = rowsOf(entries[start - 1]?.text ?? '', width) + 2

    if (used + cost > rows && start < end) {
      break
    }

    used += cost
    start -= 1
  }

  return { entries: entries.slice(start, end), earlier: start, newer }
}

function hintOf(kit: Kit): string {
  if (!kit.isFocused) {
    return 'ctrl+x tab to reply'
  }

  return kit.columns >= 48
    ? '⏎ send · tab conversations · 1-9 switch · esc close'
    : '⏎ send · esc close'
}

/**
 * A rule across `width` cells, `label` centred in it when given.
 */
export function ruleOf(width: number, label?: string): string {
  const cells = Math.max(1, width)

  if (label === undefined) {
    return '─'.repeat(cells)
  }

  const side = Math.max(1, Math.floor((cells - label.length - 2) / 2))

  return `${'─'.repeat(side)} ${label} ${'─'.repeat(Math.max(1, cells - side - label.length - 2))}`
}

function rule(kit: Kit, label?: string): RenderElement {
  const { Text } = kit.ui

  return <Text color={COLORS.muted}>{ruleOf(kit.columns, label)}</Text>
}

function groupView(kit: Kit, group: Group, width: number): RenderElement {
  const { Box, Text, Markdown } = kit.ui
  const { isSplit } = layoutOf(kit.columns)
  const isMine = group.dir === 'out'
  const color = isMine ? COLORS.accent : COLORS.peer
  const first = group.entries[0]
  const time = first?.at === undefined ? '' : ` · ${clockOf(first.at)}`
  const onRight = isMine && isSplit

  return (
    <Box flexDirection="column" marginTop={1}>
      {group.day === undefined ? null : <Box justifyContent="center">{rule(kit, group.day)}</Box>}
      <Box justifyContent={onRight ? 'flex-end' : 'flex-start'}>
        <Text>
          <Text bold color={color}>
            {isMine ? 'you' : group.peer}
          </Text>
          <Text dimColor>{time}</Text>
        </Text>
      </Box>
      {group.entries.map((entry, i) => {
        const text = truncate(entry.text, MAX_MARKDOWN)
        const cells = onRight ? widthOf(text, width) : width
        const bar = Array.from({ length: rowsOf(text, cells) }, () => '┃').join('\n')

        return (
          <Box justifyContent={onRight ? 'flex-end' : 'flex-start'} marginTop={i === 0 ? 0 : 1}>
            {onRight ? null : (
              <Box marginRight={1}>
                <Text color={color}>{bar}</Text>
              </Box>
            )}
            <Box width={cells} flexDirection="column">
              <Markdown text={text} />
            </Box>
            {onRight ? (
              <Box marginLeft={1}>
                <Text color={color}>{bar}</Text>
              </Box>
            ) : null}
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * The crosstalk pane's body, laid out for `kit.columns`: a header, one tab a
 * conversation, the selected thread anchored on its newest message, the
 * reply field and the keys that work now.
 */
export function paneView(kit: Kit, thread: Thread.Thread): RenderElement {
  const { Box, Text, Button, Input } = kit.ui
  const conversations = Thread.conversationsOf(thread)
  const selected = thread.selected ?? conversations[0]?.peer
  const { tabs, hidden } = tabsOf(conversations, selected, kit.columns)
  const { bubble } = layoutOf(kit.columns)
  const text = Math.max(1, bubble - 2)
  const threadRows = Math.max(3, kit.rows - CHROME_ROWS)
  const all = Thread.messagesWith(thread, selected)
  const window = windowOf(all, threadRows, kit.back, text)
  const self = thread.self && kit.columns >= 40 ? `● ${thread.self}` : ''

  return (
    <Box flexDirection="column" width={kit.columns} marginLeft={1}>
      <Box justifyContent="space-between">
        <Text bold color={COLORS.accent}>
          crosstalk
        </Text>
        <Text dimColor>{truncate(self, Math.max(0, kit.columns - 12))}</Text>
      </Box>

      {tabs.length === 0 ? (
        <Text dimColor>no conversation yet</Text>
      ) : (
        <Box>
          {tabs.map((tab, i) => (
            <Box marginLeft={i === 0 ? 0 : TAB_GAP}>
              <Button
                key={`tab:${tab.peer}`}
                label={tab.label}
                hotkey={tab.hotkey}
                plain
                {...(tab.isSelected ? {} : { dimColor: true })}
                onPress={() => kit.onSelect(tab.peer)}
              />
            </Box>
          ))}
          {hidden > 0 ? (
            <Box marginLeft={TAB_GAP}>
              <Text dimColor>{`+${hidden}`}</Text>
            </Box>
          ) : null}
        </Box>
      )}

      {window.earlier > 0 ? (
        <Button
          key="older"
          label={ruleOf(kit.columns, `↑ ${window.earlier} earlier`)}
          plain
          dimColor
          onPress={() => kit.onBack(Math.max(1, window.entries.length))}
        />
      ) : (
        rule(kit)
      )}

      <Box
        height={threadRows}
        flexDirection="column"
        justifyContent="flex-end"
        overflow="hidden"
      >
        {conversations.length === 0 ? (
          <Box flexDirection="column" alignItems="center">
            <Text dimColor>No other session reachable yet.</Text>
            <Text dimColor>Start one: it shows up here.</Text>
          </Box>
        ) : all.length === 0 ? (
          <Box justifyContent="center">
            <Text dimColor>{`No message with ${selected ?? 'them'} yet. Say hi below.`}</Text>
          </Box>
        ) : (
          groupsOf(window.entries).map(group => groupView(kit, group, text))
        )}
      </Box>

      {kit.notice !== undefined ? (
        <Text color={COLORS.error}>{truncate(`── ${kit.notice} `, kit.columns)}</Text>
      ) : window.newer > 0 ? (
        <Button
          key="newer"
          label={ruleOf(kit.columns, `↓ ${window.newer} newer`)}
          plain
          dimColor
          onPress={() => kit.onBack(-window.newer)}
        />
      ) : (
        rule(kit)
      )}

      {selected === undefined ? (
        <Text> </Text>
      ) : (
        <Box>
          <Text bold color={COLORS.accent}>
            {'❯ '}
          </Text>
          <Input
            key="reply"
            placeholder={`message ${selected}…`}
            submitLabel="send"
            autoFocus
            value={kit.draft}
            onInput={value => kit.onInput(value)}
            onSubmit={value => kit.onSubmit(value)}
          />
        </Box>
      )}

      <Text dimColor>{truncate(hintOf(kit), kit.columns)}</Text>
    </Box>
  )
}
