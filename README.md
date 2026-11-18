<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)"  srcset="docs/_assets/banner.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/_assets/banner-light.png">
    <img alt="crosstalk: read and join what your Claude Code sessions tell each other" src="docs/_assets/banner.png" width="100%">
  </picture>
</p>

# crosstalk

A [Claude Mod](https://github.com/anthropics/claude-code/tree/main/mods) that
turns Claude Code's cross-session messaging into a conversation you can read
and join: `/crosstalk` opens a pane with this session's exchanges with your
other Claude Code sessions, and a field to answer them yourself.

```
│ crosstalk                               ● claude-crosstalk-33  ✕
│ ─────────────────────────────────────────────────────────────
│ ○ claude-98                                             02:04
│   you: via le socket
│
│ ● claude-flow
│   no message yet
│
│ ● crimson-desert-start
│   no message yet
│ ─────────────────────────────────────────────────────────────
│ j: ↓  k: ↑  l: open  g: top  q: close
```

```
│ ‹ claude-98                                                   ✕
│ ─────────────────────────────────────────────────────────────
│ ──────────────────────── sat 19 sep ─────────────────────────
│ claude-98 · 01:28
│ ┃ Démo crosstalk depuis claude-98 : réponds-moi
│ ┃ une phrase courte via SendMessage à claude-98
│ ┃ (rien d'autre, pas d'outil en plus).
│
│                                                   you · 02:01
│                                           réponse persistée ┃
│
│                                               via le socket ┃
│ ─────────────────────────────────────────────────────────────
│ ❯ message claude-98…
│ ⏎ send · esc normal mode
```

> ⚠️ **Early access.** Mods run on Claude Code's function hooks, which are
> behind `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` and may change between releases
> without notice. crosstalk is written against the declarations in
> [`types/claude-code.d.ts`](types/claude-code.d.ts) (their first line names
> the Claude Code build).

## What it does

Claude Code already moves the messages: `SendMessage` and `ListAgents` let
sessions on one machine talk. crosstalk adds the part you see:

- **Incoming**: every peer delivery (`session.receive`, origins `peer` and
  `peer-send-message`) is recorded under the sender's name, unchanged; a
  teammate's (agent teams) or one for the session's own agents is not.
- **Outgoing**: every `SendMessage` this session makes (`tool.call`) is
  recorded under its recipient, unchanged, but for a send to a teammate.
- **The pane** (`/crosstalk`, again to close) opens on an **inbox**: one row
  a conversation (and each idle local session), most recent first, with its
  status, its name whole, its unread count, its time and its last message.
  ⏎ opens the **conversation**: the thread anchored on its newest message,
  grouped by side and day with Markdown bodies, and a reply field that sends
  through `SendMessage`; `✉ N` in its header counts what arrived elsewhere.
  It lays out for its width: your messages on the right from 56 columns,
  both sides stacked left below, a line never past 72 columns.
- **Unread**: while the pane is closed, the status line counts the messages
  nobody looked at.

Keys, vim-style, drawn at the bottom of the pane as they apply:

| | Inbox | Conversation, normal mode | Conversation, insert mode |
|---|---|---|---|
| `j` / `k` | next / previous row | scroll a message down / up | typed |
| `d` / `u` | · | half a page down / up | typed |
| `g` | top row | back to the latest | typed |
| `l`, `⏎` | open the conversation | · | `⏎` sends |
| `i` | · | reply (insert mode) | typed |
| `h` | · | back to the inbox | typed |
| `esc` | close the pane | back to the inbox | normal mode |
| `q` | close the pane | close the pane | typed |

A conversation opens in insert mode. Arrows, `⏎`, the wheel and
`PageUp`/`PageDown` work as well, and `ctrl+x tab` goes back and forth with
the prompt. Hotkeys are one lowercase letter or digit: shift is ignored (no
`G` apart from `g`), and there is no `ctrl` or count. Each conversation
keeps its own draft. The pane docks beside the transcript in the fullscreen
layout from 110 columns (`ctrl+x ←/→` resizes it), inline above the prompt
otherwise.

A message held for approval (the two sessions run in different permission
modes) already shows in the pane: crosstalk sees deliveries as they arrive,
before the engine queues them.

### History

- **Kept**: every exchange is saved in the plugin's store under the session's
  id, so a reload, a restart or a `--resume` finds the conversation as it
  was, replies typed in the pane included. The 50 most recent sessions are
  kept.
- **Retroactive**: on a session's first start with crosstalk, the history is
  rebuilt from the session's journal (`~/.claude/projects/…/<id>.jsonl`):
  the messages peers sent it and the model's `SendMessage` calls, with their
  times, including those from before the mod was installed. The plugin API
  does not expose incoming peer messages (`$.session.messages()` hides them),
  so this reads Claude Code's own journal format, which is undocumented: a
  change there empties the rebuilt history and breaks nothing else. Replies
  typed in a pane before crosstalk kept them are in no journal.
- **Renames**: a session renamed keeps its conversation once it writes again
  from the same socket, and a reply to a peer `ListAgents` no longer lists by
  that name goes to the socket it last wrote from.

Not there yet: threads with subagents or teammates, remote (Remote Control /
cloud) peers beyond what `ListAgents` reports.

### Herdr

In an interactive session that runs in a Herdr terminal (`HC_TERMINAL_ID`
set), crosstalk also publishes its conversations to a file and sends the
replies Herdr leaves in another, so Herdr can show them and answer without
the pane. Outside Herdr it does neither: no file, no timer; nor does a
`claude -p` started from that terminal, which inherits its name. This
section is the contract Herdr's `kt-crosstalk` mod reads; `v` changes when
it breaks.

Each file has one writer, so neither side can lose the other's write.

**Publication**, written by crosstalk only:
`~/.claude/cache/herdr/<HC_TERMINAL_ID>.crosstalk.json`. Rewritten whenever
what it says changes, written beside and moved over, so a reader never sees
half of one.

```json
{
  "v": 2,
  "session": {
    "id": "<session id>",
    "name": "claude-crosstalk-73",
    "terminal": "t9",
    "cwd": "/Users/me/Projects/claude-crosstalk",
    "project": "claude-crosstalk"
  },
  "updatedAt": 1794974115192,
  "peers": [
    {
      "key": "435240f6-183d-456f-84ce-af986698e725",
      "sessionId": "435240f6-183d-456f-84ce-af986698e725",
      "title": "claude-flow · #61",
      "name": "claude-flow-1d",
      "address": "claude-flow-1d",
      "project": "claude-flow",
      "topic": "#61",
      "kind": "interactive",
      "status": "busy",
      "live": true,
      "lastSeenAt": 1794974110000,
      "lastMessageAt": 1794974115000,
      "unread": 1,
      "last": { "dir": "in", "text": "**ready?**", "at": 1794974115000 }
    },
    {
      "key": "laptop-bubble",
      "title": "laptop-bubble",
      "name": "laptop-bubble",
      "address": "laptop-bubble",
      "project": "laptop-bubble",
      "kind": "remote",
      "status": "offline",
      "live": true,
      "lastSeenAt": 1794974110000,
      "unread": 0
    }
  ],
  "threads": {
    "435240f6-183d-456f-84ce-af986698e725": [
      { "dir": "out", "text": "on it", "at": 1794974100000, "id": "<outbox id>" },
      { "dir": "in", "text": "**ready?**", "at": 1794974115000 }
    ]
  },
  "handled": {
    "<outbox id>": { "status": "sent", "at": 1794974100000 },
    "<another>": { "status": "refused", "reason": "unknown peer: nobody", "at": 1794974101000 }
  }
}
```

- `session.name` is the name `ListAgents` gives this session; absent until
  it answered. In Herdr, `ListAgents` runs at the start and every 15 seconds,
  pane open or not. `project` is the name of the repository's main working
  tree (a worktree's session shares it), else of `cwd`.
- `updatedAt` is when what the file says last changed, not a heartbeat: an
  idle session leaves it as it was.
- `peers` are every conversation, most recent first, then every session
  `ListAgents` lists that nobody talked to, of every kind. Fields unknown
  are absent, never made up.
- `key` is what a conversation is filed under: the peer's session id when
  it resolves, else its live name. A session id survives `--resume`; a name
  does not (a new suffix at each start). It resolves in Herdr only: at each
  `ListAgents`, crosstalk reads the other terminals' publications and maps
  each listed name to the `session.id` that publishes it. When a name
  resolves to an id already known, its conversation joins that one, title
  and unread with it; a key can so change once, from a name to an id
  (follow it by `name`). Outside Herdr a conversation stays filed by name,
  joined across a rename only by the socket a peer writes from.
- `title` is what to call it: the title the person gave, else
  `project · topic`, else `project`, else the name. Two sessions of one
  project without a topic are told apart by their id's first characters.
  `project` comes from the peer's publication, else its name without the
  random suffix (`claude-flow-1d` gives `claude-flow`); `topic` from its
  terminal's claude-flow file (its issue, else its branch), in Herdr only.
- `name` is the live name (or the last known); `address` is where crosstalk
  sends a reply.
- `kind` is `interactive`, `remote` (Remote Control), `cloud` or
  `background`, and `status` `busy`, `waiting`, `idle` or `offline`, as
  `ListAgents` gives them. `live` says whether the last `ListAgents` listed
  it, `lastSeenAt` when one last did: both lag up to 15 seconds.
  `lastMessageAt` is the last message, in or out.
- `threads` holds each conversation's messages by `key`, oldest first, text
  as sent (Markdown); 200 messages at most across the session. `id` is on a
  message sent from Herdr's outbox only.
- `handled` is what became of each outbox entry: `sent`, or `refused` with
  the reason. It keeps every id the outbox still lists; past 200 ids in all,
  the oldest of the others go. A refused send is in no thread, as in the
  pane.

**Outbox**, written by Herdr only (write beside, then rename):
`~/.claude/cache/herdr/<HC_TERMINAL_ID>.crosstalk-outbox.json`.

```json
{
  "v": 2,
  "session": "<the publication's session.id>",
  "send": [{ "id": "<uuid>", "to": "<a peer's key>", "text": "on it", "at": 1794974100000 }],
  "read": { "<a peer's key>": 1794974115000 },
  "title": { "<a peer's key>": "API backend" }
}
```

- crosstalk looks at the file every second (its mtime and size) and reads it
  only when it changed.
- An outbox whose `v` is not 1 or 2, or whose `session` names another
  session, asks nothing. Herdr always sets `session`, so a new session in the same
  terminal never acts on what was written for the one before; an outbox
  without it is taken by whichever session of the terminal reads it.
- Each `send` entry goes out once per `id`, the way the pane's reply does:
  `SendMessage` to the peer's `address`, then the message in its thread.
  The id is saved before the send, so a reload never sends it twice (an id
  that cannot be saved is refused, not sent); one a reload cut off mid-send
  comes back `sent` when its message made it into the thread, else
  `refused` (it may have gone).
- `at` is Herdr's own: crosstalk times a message when it sends it.
- `to` must be the `key` (or the `name`) of one of the published `peers`,
  and `text` must say something: otherwise the entry is refused and nothing
  is sent. Nothing else in the file runs anything.
- Herdr drops an entry from `send` once its id is in `handled`; one left
  there is never sent again.
- `read` marks a conversation read up to a time: its published `unread`, and
  the status line, then count only what came in after it. Opening the
  conversation in the pane reads it too.
- `title` gives a conversation a title by `key` (v2); an empty one clears
  it. Titles are kept in the plugin's store by key, shared by every session,
  across renames and restarts; `r` in the pane does the same. A v1 outbox
  (no `title`, `to` and `read` by name) is still read.

Known limit: a session name is its folder's plus two hex digits, so names
come back. A conversation still filed under a name (one that never
resolved) joins whichever session holds that name when it first resolves.

A send the recipient holds for approval (the two sessions run in different
permission modes) still shows as `sent`: the engine tells this session in a
delivery notice that crosstalk does not read yet.

## Install

```bash
git clone https://github.com/kbrdn1/claude-crosstalk && cd claude-crosstalk
make install                              # from this checkout
make install SOURCE=kbrdn1/claude-crosstalk   # or from GitHub
```

`make install` adds the repo as a plugin marketplace, installs `crosstalk`,
and merges `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` into the `env` of
`~/.claude/settings.json` (nothing else in that file changes). Then, in any
new session: `/crosstalk`.

- From a checkout, the plugin **loads in place**: an edit takes effect at the
  next session start or `/reload-plugins`, no reinstall.
- From GitHub, it is a versioned copy: `make update` pulls a newer release.
- The flag turns function hooks on for **every** session, so Claude Code's
  built-in mods load too (`diff`, `agents-md`, `telemetry`, and
  `sec-default` under managed settings). `agents-md`'s default reads a
  project's `AGENTS.md` where it has no `CLAUDE.md`.

```bash
make update      # pull the latest into the installed copy (GitHub source)
make uninstall   # remove the plugin and its marketplace (the flag stays)
```

Without installing anything: `make dev` starts Claude Code with this checkout
loaded as a mod.

## Develop

Requires Claude Code (a build that carries function hooks), `bun` (for
`tsc`, oxlint and oxfmt) and `jq`.

```bash
make test       # claude plugin test .
make typecheck  # tsc against types/
make lint       # oxlint
make fmt        # oxfmt, in place (make fmt-check to only check)
make validate   # claude plugin validate
make ci         # fmt-check, lint, typecheck, validate, test
make types      # regenerate types/ after a Claude Code update
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md).

## License

[MIT](LICENSE.md) © Kylian Bardini
