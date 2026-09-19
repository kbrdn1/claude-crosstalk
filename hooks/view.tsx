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
  view: 'inbox' | 'thread'
  onOpen: (peer: string) => void
  onInbox: () => void
  onBack: (by: number) => void
  onInput: (text: string) => void
  onSubmit: (text: string) => void
}

export type Group = {
  dir: Thread.Direction
  peer: string
  day?: string
  entries: Thread.Entry[]
}

// Header, two rules, reply field, hints.
const CHROME_ROWS = 5
// Below this many columns both sides stack on the left.
const SPLIT_MIN_COLUMNS = 56
// A bubble never gets wider: a line past this reads badly.
const MAX_BUBBLE = 72
// A pause longer than this starts a new group.
const GROUP_GAP_MS = 5 * 60_000
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
 * A session name cut in its middle to `max` cells, whole when it fits:
 * names share their start (`claude-…`) and differ at their end, so both
 * ends stay.
 */
export function fitName(text: string, max: number): string {
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
 * What an inbox row says under a conversation's name: its last message's
 * first line, `you: ` before yours, cut to `width`.
 */
export function previewOf(last: Thread.Entry | undefined, width: number): string {
  if (last === undefined) {
    return 'no message yet'
  }

  const line = last.text.split('\n').find(part => part.trim() !== '') ?? ''

  return truncate(`${last.dir === 'out' ? 'you: ' : ''}${line.trim()}`, Math.max(1, width))
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
  const isWide = kit.columns >= 48

  if (kit.view === 'inbox') {
    if (!kit.isFocused) {
      return 'ctrl+x tab to choose'
    }

    return isWide ? '↑↓ choose · ⏎ open · esc close' : '⏎ open · esc close'
  }

  if (!kit.isFocused) {
    return 'ctrl+x tab to reply'
  }

  return isWide ? '⏎ send · ‹ or esc inbox' : '⏎ send · esc inbox'
}

function statusOf(thread: Thread.Thread, peer: string): { dot: string; color: string; status?: string } {
  const status = thread.peers.find(listed => listed.name === peer)?.status

  if (status === 'idle') return { dot: '●', color: COLORS.idle, status }
  if (status === 'busy') return { dot: '●', color: COLORS.busy, status }

  return status === undefined
    ? { dot: '○', color: COLORS.muted }
    : { dot: '○', color: COLORS.muted, status }
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

function header(kit: Kit, thread: Thread.Thread): RenderElement {
  const { Box, Text } = kit.ui
  const self = thread.self && kit.columns >= 40 ? `● ${thread.self}` : ''

  return (
    <Box justifyContent="space-between">
      <Text bold color={COLORS.accent}>
        crosstalk
      </Text>
      <Text dimColor>{truncate(self, Math.max(0, kit.columns - 12))}</Text>
    </Box>
  )
}

/**
 * The inbox: one row a conversation, most recent first, each with its
 * status, its name whole, its unread count and time, and its last message.
 */
function inboxView(kit: Kit, thread: Thread.Thread): RenderElement {
  const { Box, Text, Button } = kit.ui
  const conversations = Thread.conversationsOf(thread)

  return (
    <Box flexDirection="column" width={kit.columns} marginLeft={1}>
      {header(kit, thread)}
      {rule(kit)}
      {conversations.length === 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>No other session reachable yet.</Text>
          <Text dimColor>Start one: it shows up here.</Text>
        </Box>
      ) : (
        conversations.map((conversation, i) => {
          const { dot, color } = statusOf(thread, conversation.peer)
          const time = conversation.last?.at === undefined ? '' : clockOf(conversation.last.at)
          const badge = conversation.unread > 0 ? String(conversation.unread) : ''
          const side = (badge ? badge.length + 2 : 0) + time.length
          const room = Math.max(4, kit.columns - 2 - side - 1)

          return (
            <Box flexDirection="column" marginTop={i === 0 ? 0 : 1}>
              <Box justifyContent="space-between">
                <Box>
                  <Text color={color}>{`${dot} `}</Text>
                  <Button
                    key={`open:${conversation.peer}`}
                    label={fitName(conversation.peer, room)}
                    plain
                    {...(i === 0 ? { autoFocus: true as const } : {})}
                    onPress={() => kit.onOpen(conversation.peer)}
                  />
                </Box>
                <Text>
                  <Text bold color={COLORS.accent}>
                    {badge ? `${badge}  ` : ''}
                  </Text>
                  <Text dimColor>{time}</Text>
                </Text>
              </Box>
              <Text dimColor>{`  ${previewOf(conversation.last, kit.columns - 2)}`}</Text>
            </Box>
          )
        })
      )}
      {rule(kit)}
      <Text dimColor>{truncate(hintOf(kit), kit.columns)}</Text>
    </Box>
  )
}

/**
 * One conversation, laid out for `kit.columns`: its header (‹ back, name,
 * status, unread elsewhere), the thread anchored on its newest message, the
 * reply field and the keys that work now.
 */
function threadView(kit: Kit, thread: Thread.Thread): RenderElement {
  const { Box, Text, Button, Input } = kit.ui
  const selected = thread.selected ?? ''
  const { color, status } = statusOf(thread, selected)
  const elsewhere = Object.entries(thread.unread)
    .filter(([peer]) => peer !== selected)
    .reduce((sum, [, count]) => sum + count, 0)
  const { bubble } = layoutOf(kit.columns)
  const text = Math.max(1, bubble - 2)
  const threadRows = Math.max(3, kit.rows - CHROME_ROWS)
  const all = Thread.messagesWith(thread, selected)
  const window = windowOf(all, threadRows, kit.back, text)
  const badge = elsewhere > 0 ? `✉ ${elsewhere}` : ''
  const name = fitName(selected, Math.max(4, kit.columns - 4 - (status ? status.length + 3 : 0) - badge.length - 2))

  return (
    <Box flexDirection="column" width={kit.columns} marginLeft={1}>
      <Box justifyContent="space-between">
        <Box>
          <Button key="back" label="‹" plain onPress={() => kit.onInbox()} />
          <Text>
            <Text bold color={COLORS.peer}>{` ${name}`}</Text>
            <Text color={color}>{status ? ` · ${status}` : ''}</Text>
          </Text>
        </Box>
        <Text bold color={COLORS.accent}>
          {badge}
        </Text>
      </Box>

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

      <Box height={threadRows} flexDirection="column" justifyContent="flex-end" overflow="hidden">
        {all.length === 0 ? (
          <Box justifyContent="center">
            <Text dimColor>{`No message with ${selected} yet. Say hi below.`}</Text>
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

      <Text dimColor>{truncate(hintOf(kit), kit.columns)}</Text>
    </Box>
  )
}

/**
 * The crosstalk pane's body: the inbox, or the conversation opened from it.
 */
export function paneView(kit: Kit, thread: Thread.Thread): RenderElement {
  return kit.view === 'thread' && thread.selected !== undefined
    ? threadView(kit, thread)
    : inboxView(kit, thread)
}
