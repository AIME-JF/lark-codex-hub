# 消息、会话与动作协议

本文描述应用内部使用的稳定语义。它不是飞书 OpenAPI 的替代文档。

## 飞书会话范围

一个范围由以下字段组成：

```text
scope_key = chat_id + ":" + sender_open_id
```

每个范围拥有：

- 一个当前 Codex session 绑定。
- 一个工作目录偏好。
- 多个历史 session 元数据。
- 当前范围内的命令与动作上下文。

同一飞书聊天中的不同发送者不会自动共享 Codex session。

## 入站事件

### 消息

标准化消息包含：

- `eventId`：飞书事件 ID；缺失时使用稳定降级键。
- `messageId`：飞书消息 ID。
- `chatId`、`chatKind`。
- `senderOpenId`。
- 去除机器人提及后的文本。
- 是否提及机器人和本地接收时间。

群聊默认要求提及机器人。事件在进入控制器前持久化并去重。

### 卡片动作

卡片动作 ID 根据原始动作中的稳定字段派生，用于消除重复回调。动作值只接受项目生成的 `confirm` 或 `reject` 结构。

### 机器人菜单

菜单事件只接受 `hub_*` 事件键。单聊菜单事件本身没有原消息上下文，因此项目会持久记录用户最近的 P2P 范围，让菜单仍能定位正确 session。

## Codex JSONL

适配器识别以下事件语义：

| Codex 事件 | Hub 语义 |
| --- | --- |
| `thread.started` | 立即保存 Codex session ID |
| `item.started` | 执行进度 |
| `item.completed` agent message | 候选最终文本和输入状态 |
| `turn.completed` | Token 用量 |
| `turn.failed`、`error` | 类型化错误事件 |

未知事件会忽略，以保持对后续 Codex CLI 字段扩展的兼容性。

## 结构化飞书动作

`/action` 只允许中心 Schema 中的动作。当前 JSON 形式为：

```json
{
  "kind": "send_message",
  "identity": "bot",
  "receiveIdType": "open_id",
  "receiveId": "ou_xxx",
  "text": "完成"
}
```

```json
{
  "kind": "create_task",
  "identity": "user",
  "summary": "检查发布结果",
  "description": ""
}
```

```json
{
  "kind": "create_document",
  "identity": "user",
  "title": "执行报告",
  "markdown": "## 结果\n\n已完成。"
}
```

动作中不存在 executable、raw subcommand、argv 或 shell 字符串字段。

## 高风险确认

待确认记录包含：

- 96 位随机确认 ID。
- `lark-cli` 幂等键。
- 已验证的动作 JSON。
- 确认信息 JSON。
- 发起人的 operator Open ID、chat ID 和 scope key。

按钮或 `/confirm` 必须同时匹配所有权字段。数据库使用条件更新把状态从 `pending` 原子切换到 `executing`，因此重复回调不会重复执行。

旧 schema 中没有可靠所有权字段的待确认动作在迁移时标记为 `interrupted`，不能继续确认。

## 投递幂等

每一条回复、发送或卡片更新都有业务幂等键：

- 入站访问拒绝、命令结果和 Codex 结果通常从 event ID 派生。
- 主动通知未指定键时使用随机 UUID。
- 长内容的每个卡片分片使用相同业务键加分片序号。

飞书回复与主动发送 UUID 由业务键稳定派生。相同键重试时不会生成另一条逻辑消息。卡片更新替换完整卡片，本身可重复执行。

## 终态约定

### 入站任务

```text
pending -> processing -> completed
                      -> failed
                      -> interrupted
```

### 投递任务

```text
pending -> processing -> sent
   ^          |
   |          +------ retry
   +-----------------
              |
              +------ failed
```

### Codex 运行

```text
running -> completed | failed | cancelled | interrupted
```

### 飞书动作

```text
pending -> executing -> completed | failed
       -> rejected
executing -> interrupted  （启动恢复）
```

## 兼容性

- 数据库升级以 `schema_migrations` 记录版本，并在事务中执行。
- 配置使用独立的 `schemaVersion`，新增可选字段应提供默认值。
- 未识别的飞书事件不会进入业务处理。
- 未识别的 Codex JSONL 事件不会导致当前运行失败。
