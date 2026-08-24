# Lark Codex Hub

Lark Codex Hub connects a private Feishu/Lark bot to Codex CLI. It provides durable session management, controlled workspaces, proactive notifications, and an audited bridge to selected Lark capabilities.

The runtime is designed for a personal Windows workstation. Incoming messages arrive through Feishu WebSocket events; Codex runs locally in `workspace-write` mode; state is stored transactionally in SQLite; secrets are protected with Windows DPAPI.

## Highlights

- Continue or switch Codex sessions from Feishu
- Use Feishu bot menu shortcuts for help, status, sessions, cancellation, and workspace inspection
- Durable inbound and delivery queues with leases, recovery, and stable idempotency keys
- Session-level locks across Feishu scopes, with native Codex lock errors translated clearly
- Owner and chat allowlists that fail closed
- Card 2.0 confirmation for risky Lark actions
- Card 2.0 replies and proactive notifications with Markdown-aware continuation cards
- Message reactions for thinking, working, typing, completion, failure, and cancellation
- Semantic `lark-cli` allowlist with no raw command passthrough
- Durable proactive-message outbox
- Silent, restartable startup through Windows Task Scheduler with exit-code propagation
- Graceful service stop, process-tree cancellation, rotating logs, and SQLite integrity checks
- App credentials never stored in the repository

See [README.zh-CN.md](README.zh-CN.md) for installation and usage.

## Requirements

- Windows 10/11
- Node.js 22.12 or newer
- Codex CLI installed and authenticated
- A Feishu/Lark custom app with bot capability and WebSocket events for messages and bot-menu actions
- The `im:message.reactions:write_only` app scope for progress and terminal reactions
- Optional: `lark-cli` for user-identity actions

## Development

```bash
npm install
npm run check
```

## License

[MIT](LICENSE)
