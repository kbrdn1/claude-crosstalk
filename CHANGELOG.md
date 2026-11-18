# Changelog

All notable changes to this project will be documented here.

This file tracks the **in-progress** release only. Past releases live under
[`changelogs/`](changelogs/) — one Markdown file per SemVer version.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Herdr**: in a session that runs in a Herdr terminal (`HC_TERMINAL_ID`),
  crosstalk publishes its conversations to
  `~/.claude/cache/herdr/<terminal>.crosstalk.json` and sends the replies
  Herdr writes to `<terminal>.crosstalk-outbox.json`, once per id, the way
  the pane's reply field does; Herdr's read marks clear the unread count.
  Outside Herdr nothing changes. The protocol is in the README's Herdr
  section (#7).

## Past releases

In reverse chronological order:

- [`0.1.1`](changelogs/0.1.1.md), 2026-10-29
- [`0.1.0`](changelogs/0.1.0.md), 2026-09-19
