# 运维手册

本文面向已经完成安装的使用者，说明服务启停、诊断、升级、备份、恢复和卸载。首次安装请从[主 README](../README.md)开始。

## 服务生命周期

所有命令都在项目目录中执行：

```powershell
# 安装或刷新静默计划任务
node .\dist\cli\index.js service install

# 启动
node .\dist\cli\index.js service start

# 查看状态
node .\dist\cli\index.js service status

# 优雅停止
node .\dist\cli\index.js service stop

# 停止并删除计划任务
node .\dist\cli\index.js service remove
```

`service stop` 会写入本地停止请求。运行时收到请求后依次停止接收新事件、停止 TurnQueue 领取新任务、取消活动 Codex 进程树、等待任务状态落库、完成投递器收尾，最后关闭 SQLite。尚未领取的持久化 Turn 会留到下次启动。正常停止后，计划任务上次结果应为 `0`。

计划任务使用 `IgnoreNew` 保持单实例运行；请不要在同一状态目录手动再启动第二个 `start` 进程。若确实需要隔离实例，请为每个实例配置独立的 `LARK_CODEX_HUB_HOME`、飞书凭据和计划任务。

## 状态目录

默认目录为 `%USERPROFILE%\.lark-codex-hub`。可通过 `LARK_CODEX_HUB_HOME` 使用隔离目录。

```text
config.v6.json          非敏感配置、项目发现和运行参数
secrets.v2.json         当前用户 DPAPI 加密的飞书凭据
hub.sqlite              SQLite 主数据库
hub.sqlite-wal          WAL 日志，服务运行时可能存在
hub.sqlite-shm          WAL 共享内存，服务运行时可能存在
logs/hub.log*           轮转后的结构化运行日志
logs/service.log        静默启动器的原生错误输出
service-launcher.v2.*   PowerShell 和 VBS 隐藏窗口启动器
```

不要将该目录加入 Git、同步到公开网盘或作为 Issue 附件上传。

## 诊断

```powershell
node .\dist\cli\index.js doctor
node .\dist\cli\index.js status
node .\dist\cli\index.js service status
```

`doctor` 会检查：

- `config.v6.json` 是否符合配置 Schema。
- DPAPI 凭据是否能被当前 Windows 用户读取。
- 已发现会话的真实工作目录是否可用且不属于危险根目录。
- Codex CLI 版本、App Server 初始化以及只读 `thread/list` 是否可用。该检查不会执行真实 Turn，不能代替端到端消息验证。
- 启用 `lark-cli` 时，机器人和用户身份是否可用。
- SQLite schema、WAL 模式和 `integrity_check`。
- 全局 Codex Turn 并发配置是否有效；默认同时执行 1 个任务。
- Windows 计划任务是否正在运行。

诊断不会输出 App Secret 或访问 Token。

## 查看日志

```powershell
Get-Content "$env:USERPROFILE\.lark-codex-hub\logs\hub.log" -Tail 100
```

日志为每行一条 JSON，包含时间、级别、消息和结构化字段。文件按大小自动轮转，敏感字段和可识别的 Bearer/App ID 会被脱敏。

只查看错误：

```powershell
Get-Content "$env:USERPROFILE\.lark-codex-hub\logs\hub.log" |
  Select-String '"level":"error"'
```

## 升级

```powershell
node .\dist\cli\index.js service stop
git pull --ff-only
npm ci
npm run check:release
node .\dist\cli\index.js service install
node .\dist\cli\index.js service start
node .\dist\cli\index.js doctor
```

注意事项：

- 必须先优雅停止，避免构建期间删除正在使用的 `dist` 文件或复制不一致的数据库。
- `npm ci` 按锁文件安装依赖，比保留旧依赖的 `npm install` 更适合升级。
- 重新执行 `service install` 可以刷新 Node、项目目录和启动脚本路径。
- SQLite 迁移在下次打开数据库时以事务执行。

## 备份

先停止服务，再复制整个状态目录：

```powershell
node .\dist\cli\index.js service stop
Copy-Item "$env:USERPROFILE\.lark-codex-hub" `
  "D:\backup\lark-codex-hub" -Recurse
```

如果只备份数据库，也应在停止后同时保留当时存在的 `hub.sqlite`、`hub.sqlite-wal` 和 `hub.sqlite-shm`。

DPAPI 凭据只能由创建它们的 Windows 用户在原 Windows 安全上下文中解密。跨用户、跨系统或重装后恢复时，通常需要重新执行 `setup` 写入 App ID/App Secret。

## 恢复语义

服务异常退出后，下次启动会执行保守恢复：

- 已进入本地投递队列的卡片会继续重试，并复用稳定幂等 UUID。
- 处理中断的菜单和卡片事件会重新排队。
- 尚未开始的 Turn 保留在持久队列中，服务恢复后继续按顺序执行。
- 已经进入运行状态的 Turn 不会自动重跑，因为 Codex 可能已经修改文件。
- `running` 的 Codex 记录和 `executing` 的飞书动作会标记为 `interrupted`。
- 遗留的思考、执行或输入表情会尝试清理。
- 资源租约过期后可以重新获得，不需要手工删除锁文件。
- 会话占用的等待/分支选择会在重启后恢复；如果分支入队或重试子任务在崩溃点未完成，Hub 会安全标记为失败而不自动重跑，确认文件状态后可用 `/retry` 手动继续。

如果 `doctor` 报告 SQLite 完整性不是 `ok`，请先停止服务并保存所有 `hub.sqlite*` 文件，再进行任何修复。

## 与 Codex Desktop、VS Code 和 CLI 交接 session

发送 `/projects` 和 `/sessions` 可以按工作目录查看 Codex 全局持久化会话；Desktop 保存的项目名称会作为可选显示别名。发送 `/resume <ID>` 或使用恢复按钮只更新飞书绑定，不会加载 thread，也不会占用 writer。

Desktop、VS Code、CLI 和 Hub 使用同一套 Codex 持久化历史，但各自拥有独立 App Server。同一个 thread 同一时间只能有一个 writer。外部入口已经加载目标会话时，机器人会显示 A/B 占用卡片：A 会冻结原会话目标并等待释放后自动重试；B 会在同一项目目录创建空白独立会话并执行原始消息；取消则保留原绑定。

A/B 卡片按批次保存原始消息、会话 ID 和工作目录，每次待处理选择只能领取一次，过期或已结束的卡片会失效。A 等待重试期间会更新同一张卡片，不会每 5 秒新增一条提醒；等待中的状态卡会提供刷新和取消入口，也可以发送 `/cancel`。B 不继承历史，且与本地入口同时操作同一目录时仍可能产生文件冲突。

最后一个飞书 Turn 完成、失败或取消后，Hub 会回收自己的 App Server 并释放 writer。该交接不是界面实时镜像，其他客户端必要时需要刷新会话列表。

## 卸载

仅删除服务：

```powershell
node .\dist\cli\index.js service remove
```

完整卸载步骤：

1. 执行 `service remove`，确认计划任务已删除。
2. 删除项目目录。
3. 如果不再需要凭据、session、队列和日志，删除 `%USERPROFILE%\.lark-codex-hub`。

删除状态目录不可恢复，也会丢失 DPAPI 凭据和历史 session。

## 故障排查

### 机器人完全没有回复

1. 运行 `doctor`。
2. 确认计划任务为 `Running`。
3. 查看 `logs\hub.log` 是否出现“飞书长连接已就绪”。
4. 确认飞书应用版本已经发布，使用者位于可用范围。
5. 核对 `im.message.receive_v1` 和消息权限。

### 机器人回复“当前会话正忙”

- 发送 `/status`，确认 App Server 的“基础连接”可用，并检查“最近执行”是否成功；基础连接可用不代表最近一条消息执行成功。
- 检查 Codex Desktop、VS Code 或其他 Codex CLI 是否正在持有同一 session。
- 如果出现 A/B 卡片，优先点击 A；需要马上执行时点击 B。A 需要本地入口完整退出或释放该会话，Hub 不会强制删除外部锁。
- 发送 `/queue` 检查排队消息；同一范围的新消息会先等待占用选择，避免误投到已切换的会话。
- Hub 租约有过期机制；服务异常退出后无需删除文件锁。

### 快捷菜单没有反应

- 事件键必须使用 `hub_help`、`hub_cancel`、`hub_new`、`hub_status`、`hub_sessions`、`hub_history`、`hub_queue`、`hub_workspace`。
- 应用必须订阅 `application.bot.menu_v6`。
- 菜单修改后必须重新发布版本。

### 卡片按钮没有反应

- 应用必须订阅 `card.action.trigger`。
- 只有原发起人能在原聊天/会话范围内确认操作。
- 已处理、重复点击或服务异常中断的确认不会再次执行。

### 没有进度表情

- 检查 `im:message.reactions:write_only`。
- 检查 `presentation.reactionsEnabled` 是否为 `true`。
- 权限修改后重新发布应用版本。

### 开机出现 CMD 窗口

- 重新运行 `service install`，确保任务动作使用 `wscript.exe` 和隐藏 VBS 启动器。
- 删除自己添加的 `.bat`、启动文件夹快捷方式或旧计划任务，避免重复启动。
- 使用项目提供的 `LarkCodexHub` 计划任务，不要直接把 `node ... start` 放入开机启动。

### 服务反复退出

1. 查看 `logs\hub.log` 和 `logs\service.log`。
2. 运行 `doctor`，重点检查 Codex、`lark-cli` 和工作目录。
3. 如果不使用 `lark-cli`，将 `larkCli.enabled` 设置为 `false`。
4. 执行 `npm ci` 和 `npm run check` 后重新安装计划任务。

飞书后台问题参阅[飞书配置指南](FEISHU_SETUP.md)。
