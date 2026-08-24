import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const taskName = "LarkCodexHub";

function psLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function invokePowerShell(script: string, input?: unknown): Promise<string> {
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

export interface ServicePaths {
  home: string;
  installRoot: string;
  cliFile: string;
  nodeExecutable: string;
}

export function renderServiceLaunchers(paths: ServicePaths): {
  runnerPath: string;
  vbsPath: string;
  runner: string;
  vbs: string;
} {
  const runnerPath = join(paths.home, "service-launcher.v2.ps1");
  const vbsPath = join(paths.home, "service-launcher.v2.vbs");
  const runner = [
    "$ErrorActionPreference = 'Stop'",
    "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    `$env:LARK_CODEX_HUB_HOME = ${psLiteral(paths.home)}`,
    `Set-Location -LiteralPath ${psLiteral(paths.installRoot)}`,
    `& ${psLiteral(paths.nodeExecutable)} ${psLiteral(paths.cliFile)} start *>> ${psLiteral(join(paths.home, "logs", "service.log"))}`,
    "exit $LASTEXITCODE",
    ""
  ].join("\r\n");
  const command = `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runnerPath}"`;
  const vbsCommand = command.replaceAll('"', '""');
  const vbs = [
    "Option Explicit",
    "Dim shell",
    "Set shell = CreateObject(\"WScript.Shell\")",
    `shell.Run \"${vbsCommand}\", 0, True`,
    ""
  ].join("\r\n");
  return { runnerPath, vbsPath, runner, vbs };
}

export async function installScheduledTask(paths: ServicePaths): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("当前版本仅支持 Windows 计划任务。");
  }
  await mkdir(paths.home, { recursive: true });
  const launchers = renderServiceLaunchers(paths);
  await mkdir(dirname(join(paths.home, "logs", "service.log")), { recursive: true });
  await writeFile(launchers.runnerPath, `\uFEFF${launchers.runner}`, "utf8");
  await writeFile(launchers.vbsPath, launchers.vbs, "ascii");

  const registerScript = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $request.execute -Argument $request.arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Days 3650) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $request.taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
`;
  await invokePowerShell(registerScript, {
    taskName,
    execute: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe"),
    arguments: `//B //Nologo "${launchers.vbsPath}"`
  });
}

export async function removeScheduledTask(): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
$name = ${psLiteral(taskName)}
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
}
`;
  await invokePowerShell(script);
}

export async function startScheduledTask(): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
$name = ${psLiteral(taskName)}
Start-ScheduledTask -TaskName $name
`;
  await invokePowerShell(script);
}

export async function scheduledTaskStatus(): Promise<{ installed: boolean; state?: string }> {
  const script = `
$name = ${psLiteral(taskName)}
$task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($task) {
  @{ installed = $true; state = [string]$task.State } | ConvertTo-Json -Compress
} else {
  @{ installed = $false } | ConvertTo-Json -Compress
}
`;
  return JSON.parse(await invokePowerShell(script)) as {
    installed: boolean;
    state?: string;
  };
}
