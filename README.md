# Lark Codex Hub

[English](README.en.md) · [飞书配置](docs/FEISHU_SETUP.md) · [运维手册](docs/OPERATIONS.md) · [架构说明](ARCHITECTURE.md)

![version](https://img.shields.io/badge/version-1.1.0-3370ff)
![platform](https://img.shields.io/badge/platform-Windows-0078d4)
![node](https://img.shields.io/badge/Node.js-%3E%3D22.12-339933)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

把你自己的飞书机器人变成一条通往本机 Codex CLI 的安全、可靠、可恢复的远程通道。

你可以离开电脑后继续在飞书中交代编码任务、续接 Codex 会话、切换工作目录、接收完成通知，并通过受控的 `lark-cli` 扩展操作飞书。所有代码和凭据都留在自己的 Windows 电脑上，不需要公网服务器或第三方中转服务。

> [!IMPORTANT]
> 这是面向个人 Windows 工作站的自托管工具，不是多人共享的云端 Codex 服务。机器人会在你的电脑上运行 Codex 并修改允许目录内的文件，请先阅读[安全边界](#安全边界)。

## 为什么用它

- **离开电脑也能继续工作**：在手机飞书中发送需求，Codex 在本机执行并以卡片回复。
- **对话不会因重启丢失**：飞书会话与 Codex session 持久绑定，可查看历史或继续执行。
- **结果不会悄悄消失**：入站事件和回复先写入 SQLite，发送失败会自动重试。
- **进度一眼可见**：原消息依次显示思考、执行、输入、完成或失败表情。
- **默认收紧权限**：仅允许指定用户和会话，工作目录必须在白名单根目录内。
- **开机静默运行**：通过 Windows 任务计划程序启动，不弹出容易误关的 CMD 窗口。

## 功能一览

| 能力 | 基础安装 | 说明 |
| --- | :---: | --- |
| 飞书远程调用 Codex CLI | ✅ | 新建、续接、恢复和取消会话 |
| Card 2.0 回复 | ✅ | Markdown、长内容分片、状态和 Token 信息 |
| 进度与终态表情 | 可选 | 需要消息表情权限 |
| 持久化与断电恢复 | ✅ | SQLite WAL、入站队列、投递队列和幂等键 |
| Session 并发保护 | ✅ | 防止不同飞书入口同时写入同一 Codex session |
| 主动通知 | ✅ | 本地脚本可主动把任务结果发送给你 |
| 飞书快捷菜单 | 可选 | 帮助、状态、历史会话、目录、新建和取消 |
| 创建飞书任务/文档、代发消息 | 可选 | 需要安装并授权 `lark-cli`，高风险操作需卡片确认 |

## 工作方式

```mermaid
flowchart LR
    U[飞书用户] -->|消息 / 菜单 / 卡片按钮| WS[飞书长连接]
    WS --> IQ[(入站事件队列)]
    IQ --> ACL{访问与目录校验}
    ACL --> CMD[命令与会话路由]
    CMD --> CODEX[本机 Codex CLI]
    CMD --> LARK[可选 lark-cli 动作]
    CODEX --> DQ[(可靠投递队列)]
    LARK --> DQ
    DQ -->|Card 2.0| U
    CODEX -.进度事件.-> REACT[原消息表情状态]
    DB[(SQLite: session / lease / run)] --- CMD
```

一条正常回复大致会呈现为：

> **Codex 回复**　`已完成`<br>
> 耗时：22 秒　·　工作目录：`D:\project`<br>
> Codex 会话：`01ab…`　·　Token：8000 输入 / 120 输出
>
> 已完成修改，并通过类型检查。

## 环境要求

- Windows 10/11。
- Node.js 22.12 或更高版本。
- 已安装并登录 [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)。
- 一个开启机器人能力的飞书自建应用。
- Git，用于下载和更新项目。
- 可选：`lark-cli`，仅在需要创建飞书任务、文档或代发消息时安装。

当前版本没有验证 Linux、macOS、Docker 或服务器多用户部署。

## 快速开始

### 1. 配置飞书应用

在[飞书开放平台](https://open.feishu.cn/app)创建企业自建应用并开启机器人能力，然后完成以下配置：

1. 开通接收消息、机器人发送消息所需权限。
2. 使用长连接订阅 `im.message.receive_v1`。
3. 如需快捷菜单，订阅 `application.bot.menu_v6`。
4. 如需卡片按钮，订阅 `card.action.trigger`。
5. 创建并发布应用版本。

完整的权限、事件和菜单键配置见[飞书配置指南](docs/FEISHU_SETUP.md)。

### 2. 安装项目

```powershell
git clone https://github.com/AIME-JF/lark-codex-hub.git
Set-Location .\lark-codex-hub
npm ci
npm run check
```

### 3. 写入本机配置

准备以下信息：

- 飞书应用的 App ID 和 App Secret。
- 允许使用机器人的用户 `open_id`，格式通常为 `ou_xxx`。
- Codex 默认工作目录和允许访问的根目录。

凭据只通过临时环境变量进入安装程序，随后使用 Windows 当前用户的 DPAPI 加密保存：

```powershell
$env:LARK_APP_ID = "cli_xxx"
$env:LARK_APP_SECRET = "你的 App Secret"

node .\dist\cli\index.js setup --from-env `
  --owner "ou_xxx" `
  --workspace "D:\你的项目目录" `
  --allow-root "D:\允许 Codex 操作的根目录"

Remove-Item Env:LARK_APP_ID, Env:LARK_APP_SECRET
```

如果不使用 `lark-cli` 扩展，请打开 `%USERPROFILE%\.lark-codex-hub\config.v2.json`，将其关闭：

```json
{
  "larkCli": {
    "enabled": false,
    "command": "lark-cli"
  }
}
```

### 4. 诊断并静默启动

```powershell
node .\dist\cli\index.js doctor
node .\dist\cli\index.js service install
node .\dist\cli\index.js service start
node .\dist\cli\index.js service status
```

看到计划任务状态为 `Running` 后，在飞书中发送：

```text
/status
```

如果机器人返回运行状态卡片，安装完成。

## 命令速查

| 命令 | 用途 |
| --- | --- |
| `/help`、`/hub` | 查看机器人帮助 |
| `/new` | 解除当前绑定，下一条消息创建新 Codex 会话 |
| `/status` | 查看工作目录、session 和运行状态 |
| `/sessions` | 查看当前飞书范围内的历史 Codex 会话 |
| `/resume <session_id>` | 恢复一个历史会话 |
| `/cancel` | 取消当前运行任务 |
| `/workspace` | 查看当前工作目录 |
| `/workspace <目录>` | 切换到白名单内的目录并新建会话 |
| `/send <bot\|user> <open_id\|chat_id> <ID> <内容>` | 通过 `lark-cli` 发送飞书消息 |
| `/task <标题>` | 通过用户身份创建飞书任务 |
| `/doc <标题>` | 使用后续 Markdown 正文创建飞书文档 |
| `/confirm <编号>`、`/reject <编号>` | 处理高风险飞书操作 |

除命令外的普通文本会发送给当前 Codex 会话。

## 主动通知

其他本地脚本可以把完成结果写入可靠投递队列：

```powershell
node .\dist\cli\index.js notify "构建已经完成"
```

服务在线后会将通知以卡片发送给 `ownerOpenId`；临时失败会自动退避重试。

## 数据与配置

默认状态目录是 `%USERPROFILE%\.lark-codex-hub`：

| 文件 | 内容 |
| --- | --- |
| `config.v2.json` | 非敏感运行配置、用户和目录白名单 |
| `secrets.v2.json` | 当前 Windows 用户 DPAPI 加密的 App 凭据 |
| `hub.sqlite*` | session、队列、租约、运行和确认状态 |
| `logs\hub.log*` | 自动轮转并脱敏的结构化日志 |
| `service-launcher.v2.*` | 隐藏窗口启动器 |

升级、备份、卸载和恢复步骤见[运维手册](docs/OPERATIONS.md)。

## 安全边界

- 默认只有 `ownerOpenId` 可以使用机器人。
- 群聊默认必须提及机器人。
- 工作目录在解析符号链接和 Windows Junction 后仍必须位于 `allowedRoots` 内。
- Codex 只开放 `read-only` 或 `workspace-write`，项目不提供 `danger-full-access` 配置。
- 子进程通过参数数组启动，不经过 shell。
- 飞书扩展只接受固定动作 Schema，不提供原始 `lark-cli` 命令透传。
- 高风险操作绑定发起人、聊天和会话，并通过原子状态切换防止重复确认。
- App Secret 不写入仓库或普通配置文件。

更完整的威胁模型和漏洞报告方式见[安全政策](SECURITY.md)。

## 已知限制

- 飞书机器人与 Codex Desktop 可以引用同一 session，但不能同时向它写入任务；冲突时请等待一端完成，或在飞书使用 `/new`。
- 服务停止期间收到的飞书事件取决于飞书事件投递策略，项目只能恢复已经落入本地 SQLite 的事件。
- 被强制终止的 Codex 任务不会自动重跑，因为它可能已经修改过文件；重启后机器人会提示人工检查。
- 当前只支持文本提示，不支持从飞书消息直接传递图片或附件给 Codex。

## 排查问题

先运行：

```powershell
node .\dist\cli\index.js doctor
node .\dist\cli\index.js service status
Get-Content "$env:USERPROFILE\.lark-codex-hub\logs\hub.log" -Tail 50
```

| 现象 | 优先检查 |
| --- | --- |
| 完全没有回复 | 计划任务是否 `Running`、应用版本是否发布、长连接事件是否订阅 |
| 菜单没有反应 | 菜单事件键是否使用 `hub_*`，是否订阅 `application.bot.menu_v6` |
| 卡片按钮无效 | 是否订阅 `card.action.trigger`，修改后是否重新发布版本 |
| 没有进度表情 | 是否开通 `im:message.reactions:write_only` 并发布权限变更 |
| 一直提示会话忙 | Codex Desktop 是否正在使用同一 session；本地过期租约会自动释放 |

更多说明见[运维手册的故障排查章节](docs/OPERATIONS.md#故障排查)。

## 文档

- [飞书开放平台配置](docs/FEISHU_SETUP.md)
- [安装、升级、备份与故障处理](docs/OPERATIONS.md)
- [架构与可靠性设计](ARCHITECTURE.md)
- [消息、会话与动作协议](docs/PROTOCOL.md)
- [安全政策](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)
- [更新记录](CHANGELOG.md)

## 开发与贡献

```powershell
npm ci
npm run check:release
```

提交问题或 PR 前请阅读[贡献指南](CONTRIBUTING.md)。请勿在 Issue、日志或截图中公开 App Secret、Token、真实消息内容或本机路径。

## License

[MIT](LICENSE)
