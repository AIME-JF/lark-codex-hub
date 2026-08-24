# Security Policy

## Supported version

Only the latest release receives security fixes.

## Reporting

Do not open a public issue containing credentials, tokens, message content, or local paths. Contact the repository owner privately and include only the minimum reproduction data.

## Security model

- Access is denied unless the sender matches the configured owner or allowlist.
- Workspaces are resolved and checked against explicit root directories.
- Codex runs with `workspace-write` or `read-only`; unrestricted sandbox mode is not exposed.
- Child processes are spawned without a shell.
- `lark-cli` actions are discriminated schemas, not arbitrary argument arrays.
- Risk confirmations are durable and idempotent.
- Logs recursively redact fields whose names resemble secrets, tokens, authorization data, passwords, or App IDs.
- App credentials are encrypted with Windows DPAPI for the current user.

Review `config.v2.json` before adding chat or user allowlists. Never commit `.env`, `secrets.v2.json`, SQLite files, or logs.
