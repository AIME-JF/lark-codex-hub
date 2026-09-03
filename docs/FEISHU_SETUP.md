# 飞书开放平台配置

本文只说明 Lark Codex Hub 所需的飞书应用配置。项目安装和本机命令见[主 README](../README.md)。

> [!NOTE]
> 飞书开放平台的页面名称可能随版本或租户语言略有变化。优先按下文给出的 scope 和事件键搜索，不要只依赖中文名称。

## 配置清单

完成后，你的应用应满足：

- 企业自建应用已创建。
- 机器人能力已启用。
- App ID 和 App Secret 可用。
- 消息接收、机器人发送权限已开通。
- 事件订阅使用长连接。
- `im.message.receive_v1` 已添加。
- 需要菜单时，`application.bot.menu_v6` 已添加并配置 `hub_*` 事件键。
- 需要按钮时，`card.action.trigger` 已添加。
- 需要进度表情时，`im:message.reactions:write_only` 已开通。
- 最新应用版本已发布，并且使用者位于应用可用范围内。

## 1. 创建应用

1. 打开[飞书开放平台开发者后台](https://open.feishu.cn/app)。
2. 创建一个“企业自建应用”。
3. 在“凭证与基础信息”中记录 App ID 和 App Secret。
4. 在“应用能力”中添加机器人。
5. 设置机器人名称、头像和描述。

App Secret 只应输入本机安装命令。不要把它放进截图、Issue、聊天记录、Git 配置或普通 JSON 文件。

## 2. 配置权限

### 核心权限

在“权限管理”中搜索并申请与以下 scope 对应的权限：

| Scope | 用途 |
| --- | --- |
| `im:message.p2p_msg:readonly` | 接收用户发给机器人的单聊消息 |
| `im:message.group_at_msg:readonly` | 接收群聊中提及机器人的消息 |
| `im:message:send_as_bot` | 以机器人身份发送和回复消息卡片 |

某些租户会提供覆盖范围更大的 `im:message` 权限。如果使用宽权限，请在发布前确认它确实是你愿意授予的范围；项目本身只需要完成上述消息收发能力。

### 可选权限

| Scope | 何时需要 |
| --- | --- |
| `im:message.reactions:write_only` | 在原消息上添加或移除思考、执行、输入和终态表情 |

`lark-cli` 扩展使用独立的机器人或用户授权。创建任务、文档或代发消息所需权限由具体动作决定，不建议为了方便一次性开放所有飞书权限。

## 3. 配置长连接事件

1. 打开“事件与回调”。
2. 将订阅方式设置为“使用长连接接收事件”。
3. 添加以下事件：

| 事件键 | 必需 | 用途 |
| --- | :---: | --- |
| `im.message.receive_v1` | ✅ | 接收单聊和群聊消息 |
| `application.bot.menu_v6` | 可选 | 接收机器人自定义菜单点击 |
| `card.action.trigger` | 可选 | 接收确认/拒绝按钮点击 |

使用长连接时不需要准备公网回调地址。本机服务启动后会使用 App ID/App Secret 建立 WebSocket 连接。

## 4. 配置快捷菜单

在机器人能力的“自定义菜单”中创建以下菜单。显示名称可以修改，但事件键必须完全一致：

| 一级菜单 | 菜单项 | 事件键 |
| --- | --- | --- |
| 控制 | 命令菜单 | `hub_help`（打开动态 Codex 控制中心） |
| 控制 | 停止任务 | `hub_cancel` |
| 控制 | 新建会话 | `hub_new` |
| 会话 | 查看状态 | `hub_status` |
| 会话 | 历史会话 | `hub_sessions` |
| 会话 | 最近对话 | `hub_history` |
| 会话 | 消息队列 | `hub_queue` |
| 会话 | 工作目录 | `hub_workspace` |

旧版本遗留的事件键或“全部加速”等菜单不属于本项目，应删除。修改菜单后仍需创建并发布新的应用版本。

## 5. 设置可用范围并发布

1. 在应用版本页面创建新版本。
2. 确认权限、事件和机器人菜单变更都包含在版本中。
3. 将自己或测试群加入应用可用范围。
4. 提交并发布版本；如果企业要求管理员审核，请等待审核通过。

只在开发者后台保存配置但不发布，是“机器人能看到但新权限、菜单或回调不生效”的常见原因。

## 6. 获取 ownerOpenId

`ownerOpenId` 是允许控制 Codex 的飞书用户 Open ID，通常以 `ou_` 开头。不要填写 App ID、机器人 Open ID、union_id 或 chat_id。

可使用以下任一方式获取：

- 已配置 `lark-cli` 用户授权时运行 `lark-cli whoami`，读取当前用户的 Open ID。
- 使用飞书开放平台 API 调试台，以邮箱或手机号查询自己的用户 ID。
- 从可信的 `im.message.receive_v1` 测试事件中读取发送者 `open_id`，然后重新执行本机 `setup`。

不要把真实 Open ID 写进仓库示例或公开 Issue。

## 7. 本机配置

回到项目目录，按照[快速开始](../README.md#快速开始)执行 `npm ci`、`npm run check` 和 `setup`。

配置完成后，凭据位于：

```text
%USERPROFILE%\.lark-codex-hub\secrets.v2.json
```

文件内容由 Windows 当前用户的 DPAPI 加密。复制到其他 Windows 用户或重装后的系统通常无法解密，需要重新执行 `setup`。

## 8. 验证顺序

建议按以下顺序逐项测试，这样最容易定位问题：

1. 运行 `node .\dist\cli\index.js doctor`，确保配置、密钥、Codex、SQLite 和服务均正常。
2. 给机器人发送 `/status`，确认消息收发和 Card 2.0 正常。
3. 发送一条简单 Codex 请求，确认出现进度表情和正式回复。
4. 点击机器人菜单，确认 `application.bot.menu_v6` 正常。
5. 触发一个需要确认的 `lark-cli` 动作，确认卡片按钮回调正常。

## 常见问题

### 机器人完全没有回复

- 应用版本是否已发布。
- 当前用户是否在应用可用范围内。
- 是否启用了机器人能力。
- 是否使用长连接并添加 `im.message.receive_v1`。
- 计划任务是否为 `Running`。

### 单聊正常，群聊不回复

- 是否开通群聊提及消息权限。
- 是否在群聊中明确提及机器人。
- 机器人是否在群内。
- `config.v6.json` 中的 `allowedChatIds` 是否限制了该群。

### 卡片正常但按钮无效

- 是否添加 `card.action.trigger`。
- 添加事件后是否重新发布应用版本。
- 点击者是否是原操作发起人，且仍在原聊天和会话范围内。

### 菜单点击没有反应

- 是否添加 `application.bot.menu_v6`。
- 事件键是否与 `hub_*` 表格完全一致。
- 修改菜单后是否重新发布版本。

### 没有进度表情

- 是否开通 `im:message.reactions:write_only`。
- 权限变更是否已经发布。
- `presentation.reactionsEnabled` 是否为 `true`。

运行时故障继续参阅[运维手册](OPERATIONS.md#故障排查)。
