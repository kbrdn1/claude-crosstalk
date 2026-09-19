import type { CommandRunInput, RenderInput, SessionStartInput } from 'claude-code'

/**
 * What ListAgents answers in a session named claude-98 with one subagent,
 * two local peers, a Remote Control one and a cloud one.
 */
export const LISTING = `This session is claude-98 [d7f182] — the name other sessions use to message it.

Subagents (1):
  a4f662925677a1908  ·  websearch  ·  running  ·  started 33s ago

Peer sessions (4):
  api [a1aa87]  ·  interactive  ·  idle  ·  started 7d ago
  web [ef57a2]  ·  interactive  ·  busy  ·  started 16m ago
  laptop-bubble [93f800]  ·  Remote Control  ·  offline
  ultrareview: HEAD [f81815]  ·  cloud  ·  idle`

/**
 * An interactive terminal session in /work.
 */
export const SESSION: SessionStartInput = {
  surface: 'terminal',
  isInteractive: true,
  cwd: '/work',
}

/**
 * `/crosstalk` as the person types it, fullscreen on a 160-column terminal.
 */
export const CROSSTALK: CommandRunInput = {
  command: 'crosstalk',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
}

/**
 * The crosstalk pane docked on a 160-column terminal, 64 columns of body
 * and 30 rows in view.
 */
export const PANE: RenderInput<'Pane'> = {
  component: 'Pane',
  surface: 'terminal',
  requestId: 'crosstalk',
  viewport: { columns: 160, rows: 40 },
  props: {
    title: 'crosstalk',
    isFocused: true,
    bodyColumns: 64,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
}

/**
 * A peer's SendMessage as the engine delivers it to this session.
 */
export function fromPeer(peer: string, text: string) {
  return {
    origin: { kind: 'peer-send-message' as const },
    text: `<cross-session-message from="${peer}">${text}</cross-session-message>`,
  }
}

/**
 * A rendered tree's text as it reads: its strings, a Button's label and a
 * Markdown's text, in order.
 */
export function textOf(tree: unknown): string {
  if (typeof tree === 'string' || typeof tree === 'number') {
    return String(tree)
  }

  if (Array.isArray(tree)) {
    return tree.map(textOf).join('')
  }

  if (typeof tree !== 'object' || !tree) {
    return ''
  }

  const props: unknown = Reflect.get(tree, 'props')
  const lead = (key: string) => {
    const value: unknown = typeof props === 'object' && props ? Reflect.get(props, key) : undefined

    return typeof value === 'string' ? value : ''
  }

  return `${lead('label')}${lead('text')}${textOf(Reflect.get(tree, 'children') ?? [])}`
}

const API = 'uds:/tmp/cc-socks/1.sock'
const WEB = 'uds:/tmp/cc-socks/2.sock'

/**
 * A session journal as Claude Code writes it, one JSON row a line: a queued
 * framing (no origin), a peer message delivered while idle (a `user` row),
 * the model answering at the peer's socket address, a peer message
 * delivered mid-turn (a `queued_command` attachment) and again under the
 * same `msg_id`, and a line that is not JSON.
 */
export const JOURNAL: string[] = [
  {
    type: 'queue-operation',
    timestamp: '2026-09-19T10:00:00.000Z',
    content: `<cross-session-message from="${API}" from-name="api">ready?</cross-session-message>`,
  },
  {
    type: 'user',
    timestamp: '2026-09-19T10:00:01.000Z',
    isMeta: true,
    origin: { kind: 'peer', from: API, name: 'api', msg_id: 'm1', body: 'ready?' },
    message: {
      role: 'user',
      content: `Another Claude session sent a message:\n<cross-session-message from="${API}" from-name="api">\nready?\n</cross-session-message>`,
    },
  },
  {
    type: 'assistant',
    timestamp: '2026-09-19T10:00:05.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'On it.' },
        { type: 'tool_use', id: 't1', name: 'SendMessage', input: { to: API, message: 'yes, go' } },
      ],
    },
  },
  {
    type: 'attachment',
    timestamp: '2026-09-19T10:01:00.000Z',
    attachment: {
      type: 'queued_command',
      prompt: `<cross-session-message from="${WEB}" from-name="web">deployed</cross-session-message>`,
      origin: { kind: 'peer', from: WEB, name: 'web', msg_id: 'm2', body: 'deployed' },
    },
  },
  {
    type: 'attachment',
    timestamp: '2026-09-19T10:01:02.000Z',
    attachment: {
      type: 'queued_command',
      origin: { kind: 'peer', from: WEB, name: 'web', msg_id: 'm2', body: 'deployed' },
    },
  },
  'not json {',
].map(row => (typeof row === 'string' ? row : JSON.stringify(row)))

export const AT = (iso: string) => Date.parse(iso)
