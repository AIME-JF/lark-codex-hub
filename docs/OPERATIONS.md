# Operations

## State layout

The default state directory is `%USERPROFILE%\.lark-codex-hub`:

```text
config.v2.json          non-secret configuration
secrets.v2.json         current-user DPAPI-encrypted credentials
hub.sqlite*             sessions, queues, leases, runs, and approvals
logs/hub.log*           rotating structured runtime logs
service-launcher.v2.*   silent startup launchers
```

Set `LARK_CODEX_HUB_HOME` to use an isolated state directory. Never commit this directory.

## Diagnostics

Run commands from the installed project directory:

```powershell
node .\dist\cli\index.js doctor
node .\dist\cli\index.js status
node .\dist\cli\index.js service status
```

`doctor` validates the configuration, DPAPI credentials, real workspace path, Codex resume arguments, optional `lark-cli` identity, SQLite WAL/integrity, and Task Scheduler state. It never prints secret values.

## Updating

```powershell
node .\dist\cli\index.js service stop
git pull --ff-only
npm ci
npm run check:release
node .\dist\cli\index.js service install
node .\dist\cli\index.js service start
node .\dist\cli\index.js doctor
```

`service stop` creates a local shutdown request. The runtime stops receiving events, cancels the active Codex process tree, drains current workers and delivery, and closes SQLite before Task Scheduler exits. Database migrations are transactional and run on the next command that opens state.

For an important workstation, copy `hub.sqlite`, `hub.sqlite-wal`, and `hub.sqlite-shm` only after `service stop`. DPAPI secrets can be restored only by the same Windows user on the same Windows installation.

## Removing the service

```powershell
node .\dist\cli\index.js service remove
```

Removal requests a graceful stop before unregistering the scheduled task. Delete the install directory afterwards. Delete `%USERPROFILE%\.lark-codex-hub` only when credentials, session history, queued deliveries, and logs are no longer needed.

## Recovery semantics

- Delivery records are retried with bounded exponential backoff and stable Feishu request UUIDs.
- A message interrupted during Codex execution is marked `interrupted` and is not automatically rerun because it may already have modified files.
- Card and menu events interrupted before completion are requeued.
- Running Codex records and executing Lark actions left by process loss become `interrupted`.
- Stale thinking/working/typing reactions are removed at startup.
- Expired resource leases can be acquired by a later process; no manual lock-file deletion is required.

If SQLite integrity is not `ok`, stop the service and preserve all three `hub.sqlite*` files before attempting repair.

## Using the same session in Codex Desktop

The hub prevents concurrent writers inside its own process and across its SQLite scopes. Codex Desktop has its own native session lock. You may open the same session in both places, but do not send work from both at the same time. If Desktop owns the session, the bot reports that another entry is using it; wait for Desktop to finish and retry. Use `/new` in Feishu if you want an independent session.

## Troubleshooting

- No bot response: run `doctor`, then inspect the newest entries in `logs/hub.log` and confirm the scheduled task is `Running`.
- Menu does nothing: verify `application.bot.menu_v6`, exact `hub_*` event keys, and that the latest app version is published.
- Cards work but buttons do not: add the `card.action.trigger` callback and publish the app version.
- No progress reactions: grant `im:message.reactions:write_only` and publish the permission change.
- Repeated busy response: check whether Codex Desktop is still using that session; stale hub leases expire automatically.
