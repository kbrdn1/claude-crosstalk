---
name: live-check
description: Verify a crosstalk change in a real Claude Code session - start a test session in tmux with the mod loaded, open /crosstalk, send it cross-session messages, press its keys and read the pane back. Use it after any change under hooks/ that the test kit cannot fully prove (focus, esc, keyboard, layout at a real width, a real peer's envelope, the journal, a reload), before merging a pane or hook change, and whenever the user asks to see, test, check or demo crosstalk live, "en direct", or "dans une vraie session" - even if they don't name the skill.
---

# live-check

`make ci` proves what the test kit can reach. The kit cannot move the focus
ring, raise a person's `esc`, measure a real terminal, or produce a real
peer's envelope, so a change there is only proven in a real session. This
skill drives one: a second Claude Code session in tmux that you steer with
keys and read back as text, while this session plays the peer that messages
it.

Everything goes through `scripts/live.sh` (run it from the repo; `live.sh`
alone prints its commands). Doing the tmux calls by hand works too, but the
script already knows the traps below.

## The loop

1. **Start** the test session:

   ```bash
   .claude/skills/live-check/scripts/live.sh start
   ```

   It runs Haiku (cheap), without `ANTHROPIC_API_KEY` (the one in this
   environment has no credit: the session uses the claude.ai login), with
   `crossSessionInbound: accept` so your messages land without an approval
   prompt. It loads crosstalk from this checkout: in place when that is where
   the installed copy comes from, else with `--plugin-dir`. To check history,
   start it on an earlier conversation: `start --resume <session-id>`.

2. **Open the pane** with `live.sh open`. `/crosstalk` toggles, so the script
   only sends it when the pane is closed.

3. **Address it** by its `ListAgents` row, the one that reads
   `tmux xtalk-live:…`, as `name [ref]` (for instance
   `claude-crosstalk [369d54]`). Its name is the folder's, `claude-crosstalk`,
   the same as any session opened in this repo, this one often included, so
   the bare name is ambiguous. `claude --name` does not change it: it only
   sets a display name. The ref changes with each `start`.

4. **Act**:
   - A peer message: `SendMessage` to that name from this session.
   - Keys: `live.sh keys j`, `live.sh keys C-x Tab`, `live.sh keys Escape`,
     `live.sh keys PageUp`, `live.sh keys C-x Right` (resizes the dock).
   - Text in the focused field: `live.sh type "…"`. Text with Enter:
     `live.sh send "…"`.

5. **Read** the result:
   - `live.sh pane` gives the docked pane. It keeps blank rows: spacing is
     part of what you are checking, so do not filter them out.
   - `live.sh screen` gives everything, including the transcript and the
     prompt. Stray keys typed into the prompt show up there.
   - `live.sh screen --raw` keeps the colours: `\x1b[7m` (inverse) marks the
     element that holds the focus ring.

6. **After an edit** under `hooks/`, run `live.sh reload`. The installed copy
   only picks up edits on `/reload-plugins`. The script closes the pane
   first, so reopen it with `live.sh open`.

7. **Stop** with `live.sh stop`. Leave nothing running: each test session is a
   live Claude session that answers what it receives.

## Messages to the test session

Its model reads every message you send and may act on it: run a tool, edit a
file in this repo, answer you. Keep messages from doing that:

- Open with one message saying what follows is a crosstalk demo, and ask it
  to do nothing and not reply.
- Tag every later message (`[demo] …`).
- Make them realistic (a rebase heads-up, a CI result, a code snippet) when
  the layout is under test: long lines, multi-line bodies and code fences are
  what break a pane.

## What to check, by change

| Change | Look at |
|---|---|
| Layout | `pane` at the default width, then after `keys C-x Right` ×6 (narrow dock); and `LIVE_WIDTH=100` for the inline placement |
| Keys, focus, modes | Right after `open` or a view switch, type a letter: it must land in the pane (`pane`), not in the prompt (`screen`). Wait about half a second after a switch: the pane takes the keys back after `REFOCUS_MS` |
| Incoming messages | `SendMessage`, then `pane` a few seconds later: sender name, grouping, the unread badge |
| Replies from the pane | Type in the reply field and send: the message arrives here as a `cross-session-message` |
| History | `stop`, then `start --resume <id>` of the test session, then `open`: the thread must come back |

## When something looks wrong

Add `$.ui.log(\`DBG …\`)` where the doubt is (in `register.ts`), run
`live.sh reload`, replay, and read the lines back with `live.sh log`. The
engine's own lines (`crosstalk: reloaded`, a failed hook) show up there
too. Remove every `DBG` line before committing. Each fact learnt this way
belongs in the house rules' "Learnt that way" list in `CLAUDE.md`, together
with a fixture or test that pins it where the kit can.

## Traps

- `/crosstalk` toggles. Run it on an open pane and it closes; `live.sh open`
  and `close` avoid that.
- Text left in the prompt blocks everything: the pane only takes the keys
  over an empty composer, and a slash command is not run. The script sends
  `C-u` before each command; do the same after stray typing.
- `esc` in the empty prompt closes the pane (`closeOnEscape`).
- A key typed within about 400 ms of `esc` or of a switch between the inbox
  and a conversation goes to the prompt.
- Messages to a session in another permission mode are held for approval.
  They already show in the pane, but the model only sees them once
  approved. `crossSessionInbound: accept` avoids this for the test session.
  Its replies to you can still be held on your side.
