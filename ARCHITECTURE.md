# Architecture

## Boundaries

The application core depends on ports. Feishu, Codex CLI, SQLite, Windows Task Scheduler, the filesystem, and `lark-cli` are adapters. Domain and application modules do not build SDK clients or invoke shells.

```text
Feishu WebSocket
  -> normalize message/card/menu events
  -> SQLite inbound queue (deduplication + processing lease)
  -> access policy
  -> command router / Codex run service / Lark action service
  -> semantic presentation
  -> SQLite delivery queue (retry + stable idempotency key)
  -> Card 2.0 reply/send/update

Codex JSONL -> progress state machine -> Feishu message reactions
CLI notify  -> durable delivery queue -> Feishu notification card
```

## Durable processing

Inbound events are committed before the WebSocket callback returns. Workers atomically claim records with expiring leases, heartbeat while processing, and mark terminal state. Message events interrupted by process loss are not automatically rerun because they may already have changed files; card and menu events are safe to requeue.

Every reply, card update, and proactive notification is committed to the delivery outbox before it is sent. Feishu request UUIDs are deterministically derived from the delivery idempotency key, so a crash between remote acceptance and local completion does not create duplicate replies. Failed sends use bounded exponential backoff.

## Codex execution and concurrency

New work uses `codex exec [options] -`. Existing sessions use `codex exec [options] resume <session-id> -`. Parent options are placed before `resume`, JSONL is converted into typed events, prompts are sent through stdin, and child processes are spawned without a shell.

The lock resource is the Codex session ID when a binding exists, otherwise the Feishu conversation scope. This prevents two different Feishu scopes from writing the same Codex session concurrently. Native Codex session-lock errors from another local client are translated into a clear busy response. `/cancel` can still enter the inbound worker while a run is active.

On shutdown, new Feishu input is stopped, active Codex process trees are cancelled, inbound work is drained, and queued result delivery is drained before SQLite closes. Startup marks abandoned runs and actions as interrupted and removes stale progress reactions.

## Workspaces and access

A scope is the Feishu chat ID plus operator Open ID. Access is fail-closed through owner, user, and chat allowlists. Group messages require an explicit mention by default.

Workspace paths are checked after filesystem real-path resolution. Both the requested path and every allowed root must exist; symlink or Windows Junction traversal outside an allowed root is rejected.

## Lark identities and approvals

The bot identity receives events and replies. User identity is available only through the fixed `lark-cli` action schema. Raw subcommands, arguments, and shell text cannot pass through the application boundary.

An action requiring confirmation is persisted with a 96-bit random identifier and is bound to the initiating operator, chat, and scope. Confirmation uses an atomic pending-to-executing transition, so concurrent button or command submissions execute at most once. Interrupted high-risk actions are never automatically retried.

## Secrets, logs, and service lifecycle

App ID and App Secret are encrypted with current-user Windows DPAPI. Setup accepts them from stdin or temporary environment variables and removes those variables before constructing the persistent vault. Logs are structured, recursively redact sensitive fields and recognizable credentials, rotate by size, and retain a bounded number of files.

Task Scheduler launches a hidden VBS wrapper, which starts a hidden non-interactive PowerShell runner. The service emits structured logs only to files and propagates the Node process exit code so the scheduler restart policy can react to failures.
