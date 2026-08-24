# Operations

## State layout

The default state directory is `%USERPROFILE%\.lark-codex-hub`:

```text
config.v2.json          non-secret configuration
secrets.v2.json         DPAPI-encrypted credentials
hub.sqlite              sessions, leases, runs, outbox, approvals
logs/                   structured runtime logs
service-launcher.v2.*   silent startup launchers
```

Set `LARK_CODEX_HUB_HOME` to use another state directory for development or isolated validation.

## Diagnostics

```powershell
node .\dist\cli\index.js doctor
node .\dist\cli\index.js status
node .\dist\cli\index.js service status
```

`doctor` verifies configuration, DPAPI decryption, workspace access, Codex CLI, `lark-cli`, SQLite WAL, and the scheduled task. It never prints secret values.

## Updating

Stop the scheduled task process, replace the application files, run `npm ci`, `npm run check`, reinstall the scheduled task so its paths are current, then start it again. SQLite migrations run at startup.

## Removing the service

```powershell
node .\dist\cli\index.js service remove
```

After the process has stopped, delete the install directory. Delete `%USERPROFILE%\.lark-codex-hub` only if sessions, credentials, logs, and queued notifications are no longer needed.

## Recovery

A task that loses its process releases no explicit lock, but its lease expires automatically. If `doctor` reports an invalid SQLite journal, stop the service before repairing the database. Never run two bot consumers with the same App ID during cutover.
