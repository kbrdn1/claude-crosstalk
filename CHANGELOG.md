# Changelog

All notable changes to this project will be documented here.

This file tracks the **in-progress** release only. Past releases live under
[`changelogs/`](changelogs/) — one Markdown file per SemVer version.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `make lint` (oxlint) and `make fmt` / `fmt-check` (oxfmt) on `hooks/` and
  `tests/`, both in `make ci` and in CI.

### Changed

- Built and tested against Claude Code 2.1.312: `types/` regenerated, CI
  installs that build.
- The pane's emphasis through Text's `weight`, `bold` being deprecated.

### Fixed

- A teammate's message (agent teams) no longer lands in the inbox as an
  "unknown session".
- `make types` on Claude Code 2.1.312, which has no `/plugin-types`: it reads
  the declarations the engine now lays beside a mod it loads. The old recipe
  had each run start the next.
- `live.sh close` (the live-check skill) leaves the pane by `esc` instead of
  typing `/crosstalk` into a reply field.

### Dependencies

- TypeScript 7.0.2, oxlint 1.90.0, oxfmt 0.75.0; `actions/checkout` v7.

## Past releases

In reverse chronological order:

- [`0.1.0`](changelogs/0.1.0.md), 2026-09-19
