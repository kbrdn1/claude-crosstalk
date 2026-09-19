# claude-crosstalk — house rules for AI assistants

This file is the project-level CLAUDE.md. Anything stated here OVERRIDES
defaults and applies to every contribution made via an AI assistant in
this repository. `AGENTS.md` is a verbatim copy for non-Claude tools.

## What this repo is

`crosstalk`, a Claude Mod: a Claude Code plugin whose behaviour lives in a
hooks module (`hooks/register.ts`, `register(on, options)`, hooks
`($, e, next)`). The repo is also its own plugin marketplace
(`.claude-plugin/marketplace.json`, `source: "./"`).

- `hooks/thread.ts` — the conversation state, pure (no `$`).
- `hooks/view.tsx` — the pane's tree, pure over a kit of elements.
- `hooks/register.ts` — the only file that talks to the engine.
- `types/claude-code.d.ts` — the plugin API as `/plugin-types` wrote it for
  one Claude Code build (first line). Never edit it: `make types`.

## 🔴 Primordial rule — Test-Driven Development is mandatory

**No production code lands without a failing test that pinned the
behaviour down first.** PRs that add or change behaviour without tests are
sent back.

1. **Red** — a failing test under `tests/` (`claude-code/testing`), failing
   for the right reason.
2. **Green** — the minimum code to pass it.
3. **Refactor** — with `make ci` green after every step.

Where tests go:

- Pure state (`hooks/thread.ts`) → `tests/thread.test.ts`.
- Anything through the engine (a hook, the pane, a command) →
  `tests/register.test.ts`: seat what lies beneath with `on(...)` stubs
  (`world(on)`), drive with `$.session.*`, `$.tool.call`, `$.command.run`,
  read the pane with `$.ui.render(PANE)` or `$.ui.mount(...)`.
- A behaviour seen live that the kit cannot reach (focus, a real peer's
  envelope) → reproduce its input as a fixture in `tests/fixtures.ts`.

## Other house rules

- **The engine is the source of truth, not the docs.** Mods are early
  access; before relying on an event or a result shape, read it in
  `types/claude-code.d.ts`, and when behaviour matters, confirm it live with
  `make dev` (a second session sending `SendMessage`). Facts learnt that
  way: a local peer's envelope names it by `from-name`, its `from` is a
  socket address; a plugin's own `$.tool.call` does not run through its own
  `tool.call` hook; `$.session.messages()` hides peer deliveries (meta rows,
  hence the journal read); a SendMessage nobody answers resolves
  `{ success: false }`, not an error; session names change, sockets hold
  for the life of the process.
- **Record, never rewrite.** crosstalk observes `session.receive` and
  `tool.call`; it passes `e` on unchanged and never consumes a delivery.
- **After a Claude Code update**: `make types`, then `make ci`. A diff in
  `types/` is its own commit (`⬆️ chore(types): …`).
- **Release notes are per-version, never the index.** `release.yml` reads
  `changelogs/<version>.md` (or `changelogs/pre-releases/<version>.md`) and
  fails when it is missing. `.claude-plugin/plugin.json` `version` must
  equal the tag.
- **Indentation**: 2 spaces, no semicolons, single quotes (match the files).
- **Branch convention**: `<type>/#<issue>-<description>`. Worktrees via
  `gwm` (`.gwm.toml`).
- **Commit format**: Gitmoji + Conventional Commits. See
  [CONTRIBUTING.md](CONTRIBUTING.md#commits).
- **Merge strategy**: regular merge commit, never squash, never delete the
  source branch.

## Where to look for the rest

- Branch / commit / PR / release conventions → [CONTRIBUTING.md](CONTRIBUTING.md)
- Community standards → [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- The plugin API → `types/claude-code.d.ts` (its header first) and
  <https://github.com/anthropics/claude-code/tree/main/mods>
