# Lark Codex Hub

Lark Codex Hub 让你通过自己的飞书机器人远程使用本机 Codex CLI，并提供可靠的会话管理、工作目录限制、主动通知和受控的飞书扩展动作。

## 能做什么

- 在飞书里新建、续接、切换和取消 Codex 会话。
- 重启程序后继续使用已绑定的会话。
- 通过 SQLite 事务租约防止同一会话并发写入。
- 将任务完成、失败或自动化结果主动发送到飞书。
- 通过 `lark-cli` 创建任务、文档或发送消息。
- 高风险动作通过 Card 2.0 卡片确认。
- Windows 登录后静默启动，不显示 CMD 窗口。

## 环境要求

- Windows 10/11。
- Node.js 22.12 或更高版本。
- 已安装并登录 Codex CLI：`codex --version`。
- 飞书自建应用已开启机器人能力。
- 飞书应用使用长连接接收事件，并订阅 `im.message.receive_v1`。
- 若使用确认卡片，应用需要添加 `card.action.trigger` 回调。
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
/help                  查看帮助
/new                   下条消息创建新 Codex 会话
/status                查看当前状态
/sessions              查看当前飞书会话的 Codex 历史
/resume <session_id>   恢复历史 Codex 会话
/cancel                取消运行中的任务
/workspace <目录>      切换允许范围内的工作目录
/send <身份> <类型> <ID> <内容>
/task <标题>           创建飞书任务
/doc <标题>            下一行开始写 Markdown 正文并创建文档
/confirm <编号>        确认高风险操作
/reject <编号>         拒绝高风险操作
```

其他消息会直接发送给当前 Codex 会话。

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

消息失败后会自动退避重试，达到最大次数后进入失败状态，不会无限发送。

## 安全默认值

- 默认只有 `ownerOpenId` 可以使用机器人。
- 群聊默认必须提及机器人。
- 工作目录必须位于 `allowedRoots` 内。
- Codex 默认使用 `workspace-write`，不开放 `danger-full-access`。
- 飞书动作只能从固定 JSON Schema 生成，不能执行原始命令行。
- App Secret 只保存在 Windows DPAPI 密钥库中。

运维、升级与卸载见 [docs/OPERATIONS.md](docs/OPERATIONS.md)，架构见 [ARCHITECTURE.md](ARCHITECTURE.md)。
