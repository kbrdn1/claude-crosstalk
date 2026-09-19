# claude-crosstalk — house rules for AI assistants

This file is the project-level CLAUDE.md. Anything stated here OVERRIDES
defaults and applies to every contribution made via an AI assistant in
this repository. `AGENTS.md` mirrors it for non-Claude tools (only its
self-references differ); keep the two in step.

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

## Commands

- `make ci` before every push: `fmt-check` (oxfmt), `lint` (oxlint),
  `typecheck` (tsc), `validate`, `test`. The first three run through
  `bunx` at versions pinned in the Makefile: they need `bun`, nothing is
  installed in the repo. `make fmt` rewrites hooks/ and tests/ in place.
- Outside `make`, `claude plugin test .` and `claude plugin validate .` need
  `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. `claude plugin test` runs every
  `*.test.ts*`: there is no single-test filter.
- `make dev` loads this checkout in a session without installing. An
  installed copy from this checkout loads in place: `/reload-plugins`
  picks up an edit.
- CI installs exactly the Claude Code build named on line 1 of
  `types/claude-code.d.ts`.

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
- The pane (`hooks/view.tsx`) → `tests/view.test.ts`: render `paneView` as
  a pure function over fake element constructors (`FAKE_UI`, `kitOf`,
  `press`). The kit cannot move the focus ring or raise a person's `esc`.
- Anything through the engine (a hook, the pane, a command) →
  `tests/register.test.ts`: seat what lies beneath with `on(...)` stubs
  (`world(on)`), drive with `$.session.*`, `$.tool.call`, `$.command.run`,
  `$.ui.press` (`opened($, peer)` opens a conversation), read the pane with
  `$.ui.render(PANE)` or `$.ui.mount(...)`.
- Shared inputs live in `tests/fixtures.ts`. An input seen live that the
  kit cannot produce (a real peer's envelope, a journal line) is copied
  there.

## Other house rules

- **The engine is the source of truth, not the docs.** Mods are early
  access: read an event's shape in `types/claude-code.d.ts`, and confirm
  behaviour live with `make dev` and a second session sending
  `SendMessage`. Learnt that way:
  - A local peer's envelope names it by `from-name`; its `from` is a socket
    address. Session names change; sockets last as long as the process.
  - A plugin's own `$.tool.call` and `$.ui.focus` do not run through its own
    hooks: record the result, or note the ring, where the call succeeds.
  - `$.session.messages()` hides peer deliveries (meta rows), hence the
    journal read.
  - A `SendMessage` nobody answers resolves `{ success: false }`, not an
    error.
  - A pane takes the keys only when opened as a dialog (`focus`,
    `closeOnEscape`, `holdToasts`) over an empty composer. Redrawing away
    the element that holds them drops them to the prompt, and the pane can
    ask them back only once they are there (`REFOCUS_MS`).
  - A person's close is `ui.close` with origin `person`.
  - A closure drawn in a tree reads that draw's state: what moves between
    two draws (the ring) is read at the press, in `register.ts`.
- **Record, never rewrite.** crosstalk observes `session.receive` and
  `tool.call`; it passes `e` on unchanged and never consumes a delivery.
- **After a Claude Code update**: `make types`, then `make ci`. A diff in
  `types/` is its own commit (`⬆️ chore(types): …`).
- **Release notes are per-version, never the index.** `release.yml` reads
  `changelogs/<version>.md` (or `changelogs/pre-releases/<version>.md`) and
  fails when it is missing. `.claude-plugin/plugin.json` `version` must
  equal the tag.
- **Style**: oxfmt owns the layout (`.oxfmtrc.json`: 2 spaces, no
  semicolons, single quotes, 100 columns); run `make fmt`, never hand-align.
  Use `import type` for types. A hooks module has no DOM and no Node: every
  effect goes through `$`.
- **Git**: branches `<type>/#<issue>-<description>` (`#0` without an issue),
  Gitmoji + Conventional Commits, merge commits only (never squash, never
  delete the branch). Details in [CONTRIBUTING.md](CONTRIBUTING.md).

## Where to look for the rest

- Branch / commit / PR / release conventions → [CONTRIBUTING.md](CONTRIBUTING.md)
- Community standards → [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- The plugin API → `types/claude-code.d.ts` (its header first) and
  <https://github.com/anthropics/claude-code/tree/main/mods>
