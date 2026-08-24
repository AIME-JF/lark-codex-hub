# Changelog

All notable changes are documented here. This project follows Semantic Versioning.

## [1.1.0] - 2026-08-24

### Added

- Durable inbound-event and card-delivery queues with leases, retries, and stable idempotency keys.
- Startup recovery for interrupted Codex runs, Lark actions, inbound events, and message reactions.
- Session-level locking across Feishu conversation scopes.
- Real-path workspace validation that blocks symlink and Junction escapes.
- Graceful Codex process-tree shutdown, rotating structured logs, and SQLite integrity diagnostics.

### Changed

- All replies and notifications use semantic Card 2.0 presentations with Markdown continuation cards.
- Progress is shown through thinking, working, typing, and terminal message reactions.
- Risk confirmations are bound to the initiating operator, chat, and conversation scope.
- Windows startup runs silently through Task Scheduler and propagates the real service exit code.

### Fixed

- Codex resume option ordering for current CLI parsers.
- Duplicate event processing, result loss after restart, stale reaction state, and permanent lock conflicts.
- Schema 3 to schema 4 migration while preserving session and run history.

[1.1.0]: https://github.com/AIME-JF/lark-codex-hub/releases/tag/v1.1.0
