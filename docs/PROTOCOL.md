# Message and action protocol

## Conversation scope

A scope is the combination of Feishu chat ID and sender open ID. It owns one active Codex binding, a workspace preference, and a session history.

## Codex JSONL

The adapter recognizes these events:

- `thread.started`: persists the Codex session ID immediately.
- `item.started` and `item.completed`: emits progress; agent messages become candidate final text.
- `turn.completed`: records token usage when present.
- `turn.failed` and `error`: emit typed failures.

Unknown events are ignored for forward compatibility.

## Structured Feishu actions

The `/action` command accepts only one of the following JSON forms:

```json
{"kind":"send_message","identity":"bot","receiveIdType":"open_id","receiveId":"ou_xxx","text":"完成"}
```

```json
{"kind":"create_task","identity":"user","summary":"检查发布结果","description":""}
```

```json
{"kind":"create_document","identity":"user","title":"执行报告","markdown":"## 结果\n\n已完成。"}
```

Each action is validated before command arguments are produced. No action contains a raw executable, subcommand, flag array, or shell fragment.

## Card actions

Approval cards use schema `2.0` and contain a pending-action ID. Callback events are deduplicated before processing. A callback replaces the complete card with a terminal success, failure, or rejection card; it does not perform partial mutation.
