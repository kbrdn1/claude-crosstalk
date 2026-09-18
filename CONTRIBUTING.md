# Contributing to claude-crosstalk

## Table of contents

- [Development](#development)
- [Testing](#testing)
- [Branches](#branches)
- [Commits](#commits)
- [Labels](#labels)
- [Pull Requests](#pull-requests)
- [Merge strategy](#merge-strategy)
- [Releases](#releases)

## Development

### Prerequisites

- Claude Code, a build that carries function hooks (the one named on the
  first line of `types/claude-code.d.ts`, or newer after `make types`).
- `bun` (runs `tsc` through `bunx`, nothing installed in the repo) and `jq`.

### Run it

```bash
make dev    # Claude Code with this checkout loaded as a mod
```

Edits under `hooks/` reload in the running session (`crosstalk: reloaded`).
To see a conversation, start a second session and `SendMessage` to the first
by the name `ListAgents` gives it.

### Code style

2 spaces, no semicolons, single quotes, `import type` for types. A hooks
module has no DOM and no Node: web APIs only, every effect through `$`.

## Testing

### 🔴 TDD is mandatory — non-negotiable

See [CLAUDE.md](CLAUDE.md#-primordial-rule--test-driven-development-is-mandatory).
`make ci` runs typecheck, `claude plugin validate` and `claude plugin test`;
it must be green before a push.

## Branches

- `main` — what ships. Tags are cut from it.
- `dev` — integration branch; feature branches merge here.
- Feature branches: `<type>/#<issue-number>-<short-description>`, e.g.
  `feat/#4-persist-history`, `fix/#9-envelope-without-name`.

This repo is worktree-managed by `gwm` (`.gwm.toml`):
`gwm create feat 4 persist-history`.

## Commits

Format: `<emoji> <type>(<scope>)<!>: <subject>` (Gitmoji + Conventional Commits).

| Emoji | Type       | When                                    |
|:------|:-----------|:----------------------------------------|
| ✨    | `feat`     | new feature                             |
| 🐛    | `fix`      | bug fix                                 |
| 🚑️   | `hotfix`   | critical fix                            |
| ♻️    | `refactor` | restructuring, no behaviour change      |
| 📝    | `docs`     | documentation only                      |
| ✅    | `test`     | adding / fixing tests                   |
| ⚡    | `perf`     | performance improvement                 |
| 🔧    | `chore`    | repo maintenance (config, scripts)      |
| ⬆️    | `chore`    | bump (types from a new Claude Code, actions) |
| 👷    | `ci`       | CI / GitHub Actions                     |
| 🔖    | `chore`    | release                                 |

Scopes: `hooks`, `pane`, `thread`, `types`, `tests`, `docs`, `ci`, `make`.

```
✨ feat(pane): draw a peer's status next to its name
🐛 fix(thread): name a peer by from-name, not its socket
⬆️ chore(types): regenerate for Claude Code 2.1.280
```

Breaking changes: `!` after the type and a `BREAKING CHANGE:` footer.

## Labels

See [`.github/LABELS.md`](.github/LABELS.md).

## Pull Requests

- [ ] `make ci` green
- [ ] Tests added first (TDD)
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`

Use the PR template (`.github/PULL_REQUEST_TEMPLATE.md`).

## Merge strategy

Never squash, never delete the source branch:

```bash
gh pr merge <num> --merge
```

## Releases

SemVer. `-rc.N` / `-alpha.N` / `-beta.N` for pre-releases cut from `dev`.

### Step 0 — Reconcile open PRs

`gh pr list --state open`: every open PR is in the changeset, deferred on
purpose, or closed as stale.

### Stable (from `main`)

1. On `dev`: bump `version` in `.claude-plugin/plugin.json`; move
   `## [Unreleased]` out of `CHANGELOG.md` into `changelogs/<version>.md`
   (heading `# [<version>] - YYYY-MM-DD`), index it under `## Past releases`.
   Commit: `🔖 chore(release): v<version>`.
2. Merge `dev` → `main` (merge commit).
3. Tag **after** the merge, on `main`: `git tag -a v<version> -m "v<version>" && git push --tags`.
4. `release.yml` checks the tag against `plugin.json`, then publishes the
   release with `--notes-file changelogs/<version>.md`.

### Pre-release (from `dev`)

Same, with the notes in `changelogs/pre-releases/<version>-rc.N.md` (the
delta since the previous candidate) and the tag cut on `dev`; `release.yml`
publishes it as a prerelease.

### Who gets it

`make update` (or `/plugin` → update) in an installed copy pulls the new
version from the marketplace.
