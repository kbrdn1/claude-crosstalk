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
- History: every exchange saved in `$.store` per session (reload, restart,
  `--resume`), and on a session's first start the history rebuilt from its
  journal, times included, messages from before the install too.
- A renamed peer keeps its conversation; a reply to a peer no longer listed
  by name goes to the socket it last wrote from.
- An inbox (one row a conversation: status, name, unread, time, last
  message) that opens each conversation; `‹` or `esc` back.
- Vim motions: insert and normal modes in a conversation, `j k l g q` in the
  inbox, `j k d u g i h q` in normal mode, drawn as the pane's legend.
- Chat layout: messages grouped by side and day, Markdown bodies, your side
  on the right from 56 columns and stacked left below, a thread anchored on
  its newest message that the wheel and the scroll keys move while the
  header and the reply field stay; a draft per conversation.
- Repo scaffolding: plugin and marketplace manifests, pinned plugin API
  declarations (`types/`), `Makefile` (`dev`, `ci`, `install`, `update`,
  `uninstall`, `types`), CI (typecheck, validate, test), tag-driven release,
  issue / PR templates, labels, contribution and TDD house rules.

### Fixed

- A `SendMessage` no session answered (`{ success: false }`) is no longer
  drawn as sent; a refused reply says why in the pane.
- `/crosstalk` opens the pane with the keyboard, and switching between the
  inbox and a conversation keeps it: typing went to the prompt.

## Past releases

In reverse chronological order:

_(none yet)_
