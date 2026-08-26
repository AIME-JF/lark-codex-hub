# Changelog

All notable changes are documented here. This project follows Semantic Versioning.

## [1.5.0] - 2026-08-26

### Added

- Read-only Desktop project metadata aliases for Codex CLI working-directory groups.
- A persistent explicit-new-session intent that separates `/new` from merely selecting a project.

### Changed

- Desktop, VS Code, CLI, and Hub sessions now use one global Codex CLI catalog and one recyclable Hub App Server execution path.
- Configuration is schema v5 and automatically migrates v2-v4 files while preserving encrypted Feishu credentials and local policy.
- Project selection now requires a second explicit choice: resume an existing thread or create a new one.

### Removed

- The unsupported VS Code `chatgpt.cliExecutable` wrapper, bridge socket, runtime router, integration commands, and related state.

### Fixed

- Selecting a project and then sending text can no longer silently call `thread/start`.
- The VS Code extension is no longer broken by attempting to spawn a `.cmd` development override.

## [1.4.0] - 2026-08-26

### Added

- A reversible VS Code Codex wrapper that exposes the existing App Server to Hub through an authenticated local named pipe.
- Runtime routing that prefers a matching VS Code instance and waits for its active local turn instead of creating a competing writer.
- Typed session-busy cards with owner-specific handoff guidance and a durable `/retry` action that requeues the original prompt.
- VS Code integration install, status, remove, doctor checks, and shared-session labels in project navigation.

### Changed

- Runtime configuration is now schema v4 and migrates the previous v3 file without changing encrypted credentials or SQLite history.
- App Server event mapping is shared by the bridge and fallback agents.
- Desktop writer conflicts are reported separately from VS Code local-turn waiting.

## [1.3.0] - 2026-08-26

### Added

- A context-aware Codex control center with session, history, workspace, queue, status, stop, and Lark-tool actions.
- A single command registry that drives slash parsing, help content, bot-menu keys, and card callbacks.
- Paginated conversation history, localized thread states, allowed-root workspace buttons, and a configurable global Codex turn limit.
- Delivery revisions that supersede stale card retries before they can overwrite a newer card.

### Changed

- Personal workstations execute one Codex turn at a time by default through `runtime.maxConcurrentTurns`.
- Card actions render in compact two-column rows and unknown slash commands are rejected locally.
- Shutdown stops TurnQueue claims before closing App Server and draining durable delivery work.
- Database upgrades now apply every missing schema migration in one transaction.

### Fixed

- Old App Server process events can no longer clear a newly spawned process or reject its RPC requests.
- Turn completion, timeout, cancellation, shutdown, and disconnect now share a single-settlement guard.
- Read-only thread operations delay App Server recycling until their RPC work completes.
- Final live-card delivery is persisted before the live record is marked complete.
- Unauthorized card clicks no longer replace a shared group card with an access-denied result.

## [1.2.0] - 2026-08-25

### Added

- A long-lived Codex App Server adapter with initialize, thread start/resume/read/list, turn start/steer/interrupt, streamed events, and safe request rejection.
- A durable FIFO turn queue with 800 ms rapid-message coalescing, `/queue`, `/steer`, reply-to-active steering, cancellation, and restart recovery.
- Live Card 2.0 streaming that updates one progress card and reliably finalizes it through the delivery outbox.
- Readable `/sessions` cards with recovery buttons and `/history` for recent user/assistant messages.
- Real App Server handshake and read-only `thread/list` checks in `doctor`.

### Changed

- App Server is now the default execution backend; the per-message Exec adapter remains available through `codex.backend = "exec"`.
- `/status` reports App Server connection, execution backend, active turn, and pending queue depth.
- Terminal reactions can be completed for every message in a coalesced batch.
- Unrelated Lark SDK “no handler” warnings are filtered from normal service logs.

### Fixed

- Stable App Server clients no longer send the experimental `thread/resume.excludeTurns` field.
- `/status` distinguishes basic App Server connectivity from the latest Codex run result instead of reporting a false healthy state after a failed turn.
- App Server resume requests now have a protocol-level regression test against experimental-field leakage.
- Current Codex native lock wording (`already has an active writer`) is recognized as a session handoff conflict.
- New messages sent while a Feishu turn is active no longer fail just because Hub itself is busy.
- Interrupted live cards receive a clear recovery terminal state after service restart.

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

[1.1.0]: https://github.com/AIME-JF/lark-codex-hub/commit/67f144ae40bb57a2ae0d2b09debad217d61961b4
[1.2.0]: https://github.com/AIME-JF/lark-codex-hub/compare/v1.1.0...v1.2.0
[1.3.0]: https://github.com/AIME-JF/lark-codex-hub/compare/v1.2.0...v1.3.0
[1.4.0]: https://github.com/AIME-JF/lark-codex-hub/compare/v1.3.0...HEAD
