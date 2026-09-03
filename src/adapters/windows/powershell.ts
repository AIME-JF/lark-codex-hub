import { spawn } from "node:child_process";

export function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function invokePowerShell(script: string, input?: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );
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
        reject(new Error(stderr.trim() || `PowerShell exit ${String(code)}`));
      } else {
        resolve(stdout.trim());
      }
    });
    child.stdin.end(input === undefined ? "" : JSON.stringify(input), "utf8");
  });
}
