# Architecture

## Boundaries

The application core depends only on ports. Feishu, Codex CLI, SQLite, Windows, and `lark-cli` are replaceable adapters. Domain and application modules do not construct subprocess arguments or SDK clients.

```text
Feishu WebSocket
  -> message normalization
  -> access policy and durable deduplication
  -> command router
     -> session coordinator -> codex exec --json / resume
     -> action broker -> validated lark-cli invocation

execution events -> SQLite -> durable outbox -> Feishu notification
```

## Codex execution

New work uses `codex exec --json`. Existing sessions use `codex exec resume <session-id> --json`. JSONL is converted into typed domain events. The process receives prompts through stdin, runs with a fixed workspace, and is never invoked through a shell.

`codex app-server` is not a write-path dependency. A future catalog adapter may use it after feature probing, but loss or protocol change must not prevent normal execution.

## Concurrency

Every Feishu conversation scope owns at most one unexpired SQLite lease. The holder renews its heartbeat while Codex runs. A crashed process leaves no permanent lock: another holder can acquire the lease after expiration.

The session history is append-preserving. `/new` clears only the current binding, while `/sessions` and `/resume` operate on retained session metadata.

## Identities

Bot identity receives events and replies. User identity is available only through explicitly whitelisted `lark-cli` actions. Structured CLI output is successful only when `ok` is `true`. Exit code 10 becomes a pending approval; `--yes` is added only after the owner confirms.

## Proactive delivery

Proactive messages are written to the outbox before delivery. Each item has an idempotency key, attempt count, next retry time, and terminal state. Restarts do not lose queued notifications.

## Secrets

On Windows, App ID and App Secret are encrypted with user-scoped DPAPI. Cleartext travels to PowerShell through stdin, never through command-line arguments. Environment variables are accepted as an ephemeral setup source only.
