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
 * A rendered tree's text as it reads: its strings and labels, in order.
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
  const label = typeof props === 'object' && props ? Reflect.get(props, 'label') : undefined

  return `${typeof label === 'string' ? label : ''}${textOf(Reflect.get(tree, 'children') ?? [])}`
}
