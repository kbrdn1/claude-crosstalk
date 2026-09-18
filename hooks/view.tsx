/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type { Elements, RenderElement } from 'claude-code'

import * as Thread from './thread'

/**
 * Claude Dark: the accent for what this session says, blue for what a peer
 * says, green/yellow for a peer's status.
 */
export const COLORS = {
  accent: '#D4825D',
  peer: '#7AB8FF',
  idle: '#86E89A',
  busy: '#FFDF61',
  offline: '#999999',
} as const

export type Kit = {
  ui: Pick<Elements['terminal'], 'Box' | 'Text' | 'Select' | 'Input'>
  onSelect: (peer: string) => void
  onInput: (text: string) => void
  onSubmit: (text: string) => void
  draft: string
  rows: number
}

// Rows the header, the picker, the reply field and the hint take.
const CHROME_ROWS = 7

/**
 * `HH:MM` of a timestamp, in the session's local time.
 */
export function clockOf(at: number): string {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function statusColorOf(status: string | undefined): string {
  if (status === 'idle') return COLORS.idle
  if (status === 'busy') return COLORS.busy

  return COLORS.offline
}

function optionLabelOf(conversation: Thread.Conversation): string {
  const status = conversation.status ? `  ${conversation.status}` : ''
  const unread = conversation.unread > 0 ? `  (${conversation.unread} new)` : ''

  return `${conversation.peer}${status}${unread}`
}

/**
 * The crosstalk pane's body: who this session is, the conversation picker,
 * the selected conversation's last messages, and the reply field.
 */
export function paneView(kit: Kit, thread: Thread.Thread): RenderElement {
  const { Box, Text, Select, Input } = kit.ui
  const conversations = Thread.conversationsOf(thread)
  const selected = thread.selected ?? conversations[0]?.peer
  const messages = Thread.messagesWith(thread, selected)
  const fit = Math.max(2, Math.floor((kit.rows - CHROME_ROWS) / 2))
  const shown = messages.slice(-fit)
  const unread = Thread.unreadCount(thread)
  const current = conversations.find(c => c.peer === selected)

  return (
    <Box flexDirection="column" paddingLeft={1} paddingRight={3}>
      <Box justifyContent="space-between">
        <Text>
          <Text bold color={COLORS.accent}>
            crosstalk
          </Text>
          <Text dimColor>{thread.self ? `  you are ${thread.self}` : ''}</Text>
        </Text>
        <Text dimColor>
          {`${conversations.length} sessions`}
          {unread > 0 ? ` · ${unread} unread` : ''}
        </Text>
      </Box>

      {conversations.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>
            No other session reachable yet. Start one, it shows up here.
          </Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Select
            key="peer"
            label="conversation"
            options={conversations.map(c => ({ value: c.peer, label: optionLabelOf(c) }))}
            value={selected}
            onSelect={peer => kit.onSelect(peer)}
          />
        </Box>
      )}

      {selected === undefined ? null : (
        <Box
          marginTop={1}
          flexDirection="column"
          borderStyle="round"
          borderColor={COLORS.offline}
          paddingX={1}
        >
          <Text>
            <Text bold color={COLORS.peer}>
              {selected}
            </Text>
            <Text color={statusColorOf(current?.status)}>
              {current?.status ? `  ● ${current.status}` : ''}
            </Text>
            <Text dimColor>
              {messages.length > shown.length
                ? `  ${messages.length - shown.length} earlier`
                : ''}
            </Text>
          </Text>
          {shown.length === 0 ? (
            <Text dimColor>{`No message with ${selected} yet. Write one below.`}</Text>
          ) : (
            shown.map(entry => (
              <Box flexDirection="column" marginTop={1}>
                <Text>
                  <Text bold color={entry.dir === 'in' ? COLORS.peer : COLORS.accent}>
                    {entry.dir === 'in' ? `← ${entry.peer}` : '→ you'}
                  </Text>
                  <Text dimColor>{`  ${clockOf(entry.at)}`}</Text>
                </Text>
                <Text wrap="wrap">{entry.text}</Text>
              </Box>
            ))
          )}
        </Box>
      )}

      {selected === undefined ? null : (
        <Box marginTop={1}>
          <Input
            key="reply"
            label="reply"
            placeholder={`message to ${selected}`}
            submitLabel="send"
            autoFocus
            value={kit.draft}
            onInput={text => kit.onInput(text)}
            onSubmit={text => kit.onSubmit(text)}
          />
        </Box>
      )}

      <Text dimColor>tab: move · enter: send · esc: close</Text>
    </Box>
  )
}
