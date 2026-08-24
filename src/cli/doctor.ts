import { spawn } from "node:child_process";
import { join } from "node:path";
import { FileConfigStore } from "../adapters/config/file-config.js";
import { createSecretVault } from "../adapters/secrets/create-vault.js";
import { openDatabase } from "../adapters/sqlite/database.js";
import { SqliteStateStore } from "../adapters/sqlite/state-store.js";
import { scheduledTaskStatus } from "../adapters/windows/scheduled-task.js";
import { resolveCommand } from "../adapters/process/command-resolver.js";
import { NodeWorkspaceResolver } from "../adapters/fs/node-workspace-resolver.js";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

function commandOutput(command: string, args: string[]): Promise<string> {
  return new Promise((resolveResult, reject) => {
    void resolveCommand(command).then((resolved) => {
      const child = spawn(resolved.executable, [...resolved.prefixArgs, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => child.kill("SIGTERM"), 15_000);
      timeout.unref();
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (part: string) => {
        stdout = `${stdout}${part}`.slice(-16_000);
      });
      child.stderr.on("data", (part: string) => {
        stderr = `${stderr}${part}`.slice(-16_000);
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolveResult(stdout.trim());
        } else {
          reject(new Error(stderr.trim() || `exit ${String(code)}`));
        }
      });
    }).catch(reject);
  });
}

export async function runDoctor(home: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  let config;
  try {
    config = await new FileConfigStore(home).load();
    checks.push({ name: "配置", ok: true, detail: "config.v2.json 有效" });
  } catch (error) {
    checks.push({ name: "配置", ok: false, detail: String(error) });
    return checks;
  }

  try {
    const vault = createSecretVault(home);
    const appId = await vault.get("feishu.app_id");
    const appSecret = await vault.get("feishu.app_secret");
    checks.push({
      name: "密钥",
      ok: Boolean(appId && appSecret),
      detail: appId && appSecret ? "DPAPI 密钥可读取" : "缺少 App ID 或 App Secret"
    });
  } catch (error) {
    checks.push({ name: "密钥", ok: false, detail: String(error) });
  }

  try {
    const workspace = await new NodeWorkspaceResolver().resolveAllowed(
      config.workspace.defaultRoot,
      config.workspace.defaultRoot,
      config.workspace.allowedRoots
    );
    checks.push({ name: "工作目录", ok: true, detail: workspace });
  } catch (error) {
    checks.push({ name: "工作目录", ok: false, detail: String(error) });
  }

  try {
    const version = await commandOutput(config.codex.command, ["--version"]);
    checks.push({ name: "Codex CLI", ok: true, detail: version });
  } catch (error) {
    checks.push({ name: "Codex CLI", ok: false, detail: String(error) });
  }

  try {
    await commandOutput(config.codex.command, [
      "exec",
      "--json",
      "--color",
      "never",
      "-c",
      'approval_policy="never"',
      "--sandbox",
      config.codex.sandbox,
      "--cd",
      config.workspace.defaultRoot,
      "resume",
      "--help"
    ]);
    checks.push({ name: "Codex 参数", ok: true, detail: "新建与恢复会话参数兼容" });
  } catch (error) {
    checks.push({ name: "Codex 参数", ok: false, detail: String(error) });
  }

  if (config.larkCli.enabled) {
    try {
      const raw = await commandOutput(config.larkCli.command, ["auth", "status"]);
      const parsed = JSON.parse(raw) as {
        identities?: { bot?: { available?: boolean }; user?: { available?: boolean } };
      };
      const bot = parsed.identities?.bot?.available === true;
      const user = parsed.identities?.user?.available === true;
      checks.push({
        name: "lark-cli",
        ok: bot,
        detail: `机器人身份：${bot ? "可用" : "不可用"}；用户身份：${user ? "可用" : "不可用"}`
      });
    } catch (error) {
      checks.push({ name: "lark-cli", ok: false, detail: String(error) });
    }
  }

  try {
    const store = new SqliteStateStore(openDatabase(join(home, "hub.sqlite")));
    store.migrate();
    const health = store.health();
    store.close();
    checks.push({
      name: "SQLite",
      ok:
        health.journalMode.toLowerCase() === "wal" &&
        health.integrity.toLowerCase() === "ok",
      detail: `schema=${health.schemaVersion}, journal=${health.journalMode}, integrity=${health.integrity}`
    });
  } catch (error) {
    checks.push({ name: "SQLite", ok: false, detail: String(error) });
  }

  if (process.platform === "win32") {
    try {
      const status = await scheduledTaskStatus();
      checks.push({
        name: "静默启动",
        ok: !status.installed || status.state === "Running",
        detail: status.installed
          ? `计划任务状态：${status.state ?? "未知"}；上次结果：${String(status.lastTaskResult ?? "未知")}`
          : "尚未安装（可选）"
      });
    } catch (error) {
      checks.push({ name: "静默启动", ok: false, detail: String(error) });
    }
  }
  return checks;
}
