# Lark Codex Hub

Lark Codex Hub connects a private Feishu/Lark bot to Codex CLI. It provides durable session management, controlled workspaces, proactive notifications, and an audited bridge to selected Lark capabilities.

The runtime is designed for a personal Windows workstation. Incoming messages arrive through Feishu WebSocket events; Codex runs locally in `workspace-write` mode; state is stored transactionally in SQLite; secrets are protected with Windows DPAPI.

## Highlights

- Continue or switch Codex sessions from Feishu
- SQLite leases instead of file locks
- Owner and chat allowlists that fail closed
- Card 2.0 confirmation for risky Lark actions
- Semantic `lark-cli` allowlist with no raw command passthrough
- Durable proactive-message outbox
- Silent startup through Windows Task Scheduler
- App credentials never stored in the repository

See [README.zh-CN.md](README.zh-CN.md) for installation and usage.

## Requirements

- Windows 10/11
- Node.js 22.12 or newer
- Codex CLI installed and authenticated
- A Feishu/Lark custom app with bot capability and WebSocket events
- Optional: `lark-cli` for user-identity actions

## Development

```bash
npm install
npm run check
```

## License

[MIT](LICENSE)
