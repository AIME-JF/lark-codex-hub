# Lark Codex Hub

Lark Codex Hub 让你通过自己的飞书机器人远程使用本机 Codex CLI，并提供可靠的会话管理、工作目录限制、主动通知和受控的飞书扩展动作。

## 能做什么

- 在飞书里新建、续接、切换和取消 Codex 会话。
- 重启程序后继续使用已绑定的会话。
- 通过 SQLite 事务租约防止同一会话并发写入。
- 飞书入站事件和所有卡片回复先持久化，断电重启后可恢复且避免重复回复。
- 将任务完成、失败或自动化结果主动发送到飞书。
- 通过 `lark-cli` 创建任务、文档或发送消息。
- 高风险动作通过 Card 2.0 卡片确认。
- 所有回复和主动通知使用 Card 2.0，并在原消息上显示思考、执行、输入和完成状态。
- 使用飞书机器人快捷菜单查看帮助、状态、会话和工作目录，或停止、新建任务。
- Windows 登录后静默启动，不显示 CMD 窗口。

## 环境要求

- Windows 10/11。
- Node.js 22.12 或更高版本。
- 已安装并登录 Codex CLI：`codex --version`。
- 飞书自建应用已开启机器人能力。
- 飞书应用使用长连接接收事件，并订阅 `im.message.receive_v1` 和 `application.bot.menu_v6`。
- 若使用确认卡片，应用需要添加 `card.action.trigger` 回调。
- 若使用消息状态表情，应用需要开通 `im:message.reactions:write_only` 权限并发布新版本。
- 若使用扩展动作，安装并登录 `lark-cli`。

## 安装

```powershell
git clone https://github.com/AIME-JF/lark-codex-hub.git
Set-Location .\lark-codex-hub
npm install
npm run check
```

首次配置时，通过临时环境变量提供凭据。凭据会写入 Windows 当前用户的 DPAPI 密钥库，不会进入配置文件：

```powershell
$env:LARK_APP_ID = "cli_xxx"
$env:LARK_APP_SECRET = "你的 App Secret"
node .\dist\cli\index.js setup --from-env `
  --owner "ou_xxx" `
  --workspace "D:\你的项目目录" `
  --allow-root "D:\允许 Codex 操作的根目录"
Remove-Item Env:LARK_APP_ID, Env:LARK_APP_SECRET
```

先执行诊断：

```powershell
node .\dist\cli\index.js doctor
```

前台验证：

```powershell
node .\dist\cli\index.js start
```

验证成功后安装静默启动任务：

```powershell
node .\dist\cli\index.js service install
node .\dist\cli\index.js service start
node .\dist\cli\index.js service status
```

## 飞书命令

```text
/help 或 /hub          查看帮助
/new                   下条消息创建新 Codex 会话
/status                查看当前状态
/sessions              查看当前飞书会话的 Codex 历史
/resume <session_id>   恢复历史 Codex 会话
/cancel                取消运行中的任务
/workspace             查看当前工作目录
/workspace <目录>      切换允许范围内的工作目录
/send <身份> <类型> <ID> <内容>
/task <标题>           创建飞书任务
/doc <标题>            下一行开始写 Markdown 正文并创建文档
/confirm <编号>        确认高风险操作
/reject <编号>         拒绝高风险操作
```

其他消息会直接发送给当前 Codex 会话。

## 卡片与进度表情

Codex 长任务不会额外发送“已开始处理”消息，而是在原消息上依次切换 `THINKING`、`OnIt` 和 `Typing` 表情。正式卡片回复成功后保留 `DONE`；失败保留 `ERROR`；取消保留 `CrossMark`。临时表情状态存入 SQLite，服务重启时会清理未完成任务遗留的表情。

已有配置缺少以下字段时会自动采用默认值；也可以在 `config.v2.json` 中显式关闭：

```json
{
  "presentation": {
    "cardsEnabled": true,
    "reactionsEnabled": true,
    "keepTerminalReaction": true
  }
}
```

超长 Markdown 回复会自动拆成连续编号卡片；若卡片发送失败，服务会记录警告并降级为文本回复。

## 机器人快捷菜单

在飞书开放平台的机器人菜单中配置以下菜单项，并让事件键与表格保持一致：

| 一级菜单 | 菜单项 | 事件键 |
| --- | --- | --- |
| 控制 | 命令菜单 | `hub_help` |
| 控制 | 停止任务 | `hub_cancel` |
| 控制 | 新建会话 | `hub_new` |
| 会话 | 查看状态 | `hub_status` |
| 会话 | 历史会话 | `hub_sessions` |
| 会话 | 工作目录 | `hub_workspace` |

菜单点击由 `application.bot.menu_v6` 事件处理。修改菜单后需要保存并发布应用版本；“全部加速”不属于本项目命令，应从旧菜单中移除。

示例：

```text
/send bot open_id ou_xxx 构建已经完成
```

```text
/doc 本周进展
## 已完成

完成远程机器人接入。
```

## 主动通知

运行中的服务会消费持久化通知队列：

```powershell
node .\dist\cli\index.js notify "后台任务已经完成"
```

通知以 Card 2.0 卡片发送。消息失败后会自动退避重试，达到最大次数后进入失败状态，不会无限发送。

## 与 Codex 桌面端同时使用

可以在飞书机器人和 Codex 桌面端看到同一个 session，但不要同时向它们发送任务。本项目会阻止自身不同飞书会话并发写入同一个 session；桌面端占用 session 时，则由 Codex 原生锁拦截，机器人会提示“另一个入口正在使用”。等待桌面端任务结束后重试，或在飞书发送 `/new` 建立独立会话。

## 静默服务诊断

计划任务安装后，`doctor` 会把“任务已安装但没有运行”视为故障。静默启动器会把 Node 进程退出码传回任务计划程序，以便按策略自动重启；使用电池供电时也不会拒绝启动或主动停止。

```powershell
node .\dist\cli\index.js service status
node .\dist\cli\index.js doctor
```

升级或维护前请优雅停止：

```powershell
node .\dist\cli\index.js service stop
```

## 安全默认值

- 默认只有 `ownerOpenId` 可以使用机器人。
- 群聊默认必须提及机器人。
- 工作目录必须位于 `allowedRoots` 内。
- Codex 默认使用 `workspace-write`，不开放 `danger-full-access`。
- 飞书动作只能从固定 JSON Schema 生成，不能执行原始命令行。
- App Secret 只保存在 Windows DPAPI 密钥库中。

运维、升级与卸载见 [docs/OPERATIONS.md](docs/OPERATIONS.md)，架构见 [ARCHITECTURE.md](ARCHITECTURE.md)。
