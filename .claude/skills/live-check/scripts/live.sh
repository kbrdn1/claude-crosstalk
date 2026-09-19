#!/usr/bin/env bash
# live.sh — drive a live Claude Code test session with crosstalk loaded, in tmux.
#
#   live.sh start [--resume <session-id>]   start the test session (haiku, cheap)
#   live.sh open | close                     /crosstalk, only when it changes state
#   live.sh keys <tmux key>...               e.g. keys j · keys C-x Tab · keys Escape
#   live.sh type <text>                      literal text, no Enter
#   live.sh send <text>                      literal text, then Enter
#   live.sh pane                             the docked pane, blank rows kept
#   live.sh screen [--raw]                   the whole screen (--raw: with colours)
#   live.sh log [pattern]                    transcript lines matching (default: DBG and the mod's own)
#   live.sh reload                           close the pane, /reload-plugins
#   live.sh stop                             kill the test session
#
# Env: LIVE_SESSION (tmux session, default xtalk-live), LIVE_WIDTH/LIVE_HEIGHT
# (default 200x44: wide enough to dock the pane), LIVE_MODEL (default haiku).
set -euo pipefail

SESSION=${LIVE_SESSION:-xtalk-live}
WIDTH=${LIVE_WIDTH:-200}
HEIGHT=${LIVE_HEIGHT:-44}
MODEL=${LIVE_MODEL:-haiku}
ROOT=$(git rev-parse --show-toplevel)

die() { printf 'live.sh: %s\n' "$*" >&2; exit 1; }
alive() { tmux has-session -t "$SESSION" 2>/dev/null; }
need() { alive || die "no session $SESSION: live.sh start first"; }
screen() { tmux capture-pane -t "$SESSION" -p "$@"; }
# The docked pane is the column right of the last │ of each row.
pane() { screen | awk -F'│' 'NF>1 {print "│" $NF}'; }
is_open() { pane | grep -qE '│ (crosstalk  |‹ )'; }

# Waits until the prompt is up, accepting the folder-trust dialog on the way.
wait_ready() {
  for _ in $(seq 1 40); do
    if screen | grep -q 'Yes, I trust this folder'; then
      tmux send-keys -t "$SESSION" Down
      sleep 0.3
      tmux send-keys -t "$SESSION" Enter
    fi
    # The prompt row starts with ❯ at column 0 (the trust dialog's is indented).
    screen | grep -q '^❯' && ! screen | grep -q 'trust this folder' && return 0
    sleep 0.5
  done
  die "the session did not come up; live.sh screen shows why"
}

# The installed copy loads in place when its marketplace is this checkout;
# loading it again with --plugin-dir would register the hooks twice.
plugin_args() {
  local known="$HOME/.claude/plugins/known_marketplaces.json"
  local path=""
  [ -f "$known" ] && path=$(jq -r '.["claude-crosstalk"].source.path // empty' "$known")
  [ "$path" = "$ROOT" ] || printf -- '--plugin-dir %q' "$ROOT"
}

cmd=${1:-}
shift || true

case "$cmd" in
  start)
    alive && die "session $SESSION is already running (live.sh stop first)"
    resume=""
    if [ "${1:-}" = "--resume" ]; then
      [ -n "${2:-}" ] || die "--resume needs a session id"
      resume="--resume $2"
    fi
    # No ANTHROPIC_API_KEY: the session runs on the claude.ai login. Peers are
    # accepted without approval, so a message lands in the pane at once.
    tmux new-session -d -s "$SESSION" -x "$WIDTH" -y "$HEIGHT" -c "$ROOT" \
      "env -u ANTHROPIC_API_KEY CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --model $MODEL \
       --settings '{\"crossSessionInbound\":\"accept\"}' $(plugin_args) $resume"
    wait_ready
    # Its cross-session name is the folder's (--name only sets a display
    # name): ListAgents tells it apart from others by its tmux location.
    printf 'started %s: its ListAgents row reads "tmux %s:…"; message it as "<name> [<ref>]"\n' \
      "$SESSION" "$SESSION"
    ;;
  open | close)
    need
    want=$([ "$cmd" = open ] && echo yes || echo no)
    has=$(is_open && echo yes || echo no)
    if [ "$want" != "$has" ]; then
      tmux send-keys -t "$SESSION" C-u
      tmux send-keys -t "$SESSION" -l "/crosstalk"
      sleep 0.3
      tmux send-keys -t "$SESSION" Enter
      sleep 4
    fi
    printf 'pane %s\n' "$(is_open && echo open || echo closed)"
    ;;
  keys)
    need
    [ $# -gt 0 ] || die "keys needs at least one tmux key"
    tmux send-keys -t "$SESSION" "$@"
    sleep 1
    ;;
  type | send)
    need
    tmux send-keys -t "$SESSION" -l "$*"
    [ "$cmd" = send ] && { sleep 0.3; tmux send-keys -t "$SESSION" Enter; }
    sleep 1
    ;;
  pane)
    need
    pane
    ;;
  screen)
    need
    if [ "${1:-}" = "--raw" ]; then screen -e; else screen; fi
    ;;
  log)
    need
    screen -S -200 | grep -E "${1:-DBG|[⏺⎿] +crosstalk:}" || true
    ;;
  reload)
    need
    # Esc closes the pane (or leaves a field); C-u empties the composer, which
    # must be empty for the command to run and for the pane to get the keys.
    is_open && { tmux send-keys -t "$SESSION" Escape; sleep 1; }
    is_open && { tmux send-keys -t "$SESSION" Escape; sleep 1; }
    tmux send-keys -t "$SESSION" C-u
    tmux send-keys -t "$SESSION" -l "/reload-plugins"
    sleep 0.3
    tmux send-keys -t "$SESSION" Enter
    sleep 6
    screen | grep -E 'Reloaded:' | tail -1
    ;;
  stop)
    alive && tmux kill-session -t "$SESSION"
    printf 'stopped %s\n' "$SESSION"
    ;;
  *)
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
    [ -z "$cmd" ] || exit 1
    ;;
esac
