import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";

export interface ResolvedCommand {
  executable: string;
  prefixArgs: string[];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function where(command: string): Promise<string[]> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("where.exe", [command], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (part: string) => {
      stdout += part;
    });
    child.stderr.on("data", (part: string) => {
      stderr += part;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `找不到命令：${command}`));
        return;
      }
      resolveResult(
        stdout
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean)
      );
    });
  });
}

export async function resolveWindowsCmdShim(path: string): Promise<ResolvedCommand> {
  const content = await readFile(path, "utf8");
  const match = content.match(/["']%dp0%[\\/]([^"']+\.(?:js|mjs|cjs))["']\s+%\*/iu);
  if (!match?.[1]) {
    throw new Error(`无法安全解析 Windows 命令垫片：${path}`);
  }
  const script = resolve(dirname(path), match[1].replaceAll("\\", "/"));
  if (!(await exists(script))) {
    throw new Error(`命令垫片指向的入口不存在：${script}`);
  }
  const localNode = resolve(dirname(path), "node.exe");
  return {
    executable: (await exists(localNode)) ? localNode : process.execPath,
    prefixArgs: [script]
  };
}

export async function resolveCommand(command: string): Promise<ResolvedCommand> {
  if (process.platform !== "win32") {
    return { executable: command, prefixArgs: [] };
  }

  const explicit = isAbsolute(command) || command.includes("\\") || command.includes("/");
  const candidates = explicit ? [resolve(command)] : await where(command);
  const cmd = candidates.find((candidate) => extname(candidate).toLowerCase() === ".cmd");
  if (cmd) {
    return resolveWindowsCmdShim(cmd);
  }
  const executable = candidates.find(
    (candidate) => extname(candidate).toLowerCase() === ".exe"
  );
  if (executable) {
    return { executable, prefixArgs: [] };
  }
  const script = candidates.find((candidate) =>
    [".js", ".mjs", ".cjs"].includes(extname(candidate).toLowerCase())
  );
  if (script) {
    return { executable: process.execPath, prefixArgs: [script] };
  }
  throw new Error(`找不到可安全执行的 Windows 命令入口：${command}`);
}
