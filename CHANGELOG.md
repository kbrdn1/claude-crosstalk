# Changelog

All notable changes to this project will be documented here.

This file tracks the **in-progress** release only. Past releases live under
[`changelogs/`](changelogs/) — one Markdown file per SemVer version.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `/crosstalk`: a pane listing this session's conversations with its peer
  sessions, fed by `session.receive` (peer deliveries in, named by their
  `from-name`) and `tool.call` on `SendMessage` (messages out), with a
  conversation picker, the last messages of the selected one, and a reply
  field that sends through `SendMessage` (`ctrl+x tab` to focus it).
- Peer list and statuses from `ListAgents`, refreshed every 15 s while the
  pane is open; an `unread` count in the status line while it is closed.
- Repo scaffolding: plugin and marketplace manifests, pinned plugin API
  declarations (`types/`), `Makefile` (`dev`, `ci`, `install`, `update`,
  `uninstall`, `types`), CI (typecheck, validate, test), tag-driven release,
  issue / PR templates, labels, contribution and TDD house rules.

## Past releases

In reverse chronological order:

_(none yet)_
