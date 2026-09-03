import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { invokePowerShell, psLiteral } from "./powershell.js";

const taskName = "LarkCodexHub";
const lifecycleTaskName = "LarkCodexHubLifecycle";

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
  lifecycleRunnerPath: string;
  lifecycleVbsPath: string;
  lifecycleRunner: string;
  lifecycleVbs: string;
} {
  const runnerPath = join(paths.home, "service-launcher.v2.ps1");
  const vbsPath = join(paths.home, "service-launcher.v2.vbs");
  const runner = [
    "$ErrorActionPreference = 'Stop'",
    "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    `$env:LARK_CODEX_HUB_HOME = ${psLiteral(paths.home)}`,
    "$env:LARK_CODEX_HUB_SERVICE = '1'",
    `Set-Location -LiteralPath ${psLiteral(paths.installRoot)}`,
    "$ErrorActionPreference = 'Continue'",
    `& ${psLiteral(paths.nodeExecutable)} ${psLiteral(paths.cliFile)} start 2>> ${psLiteral(join(paths.home, "logs", "service.log"))}`,
    "$serviceExitCode = $LASTEXITCODE",
    "exit $serviceExitCode",
    ""
  ].join("\r\n");
  const command = `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${runnerPath}"`;
  const vbsCommand = command.replaceAll('"', '""');
  const vbs = [
    "Option Explicit",
    "Dim shell, exitCode",
    "Set shell = CreateObject(\"WScript.Shell\")",
    `exitCode = shell.Run(\"${vbsCommand}\", 0, True)`,
    "WScript.Quit exitCode",
    ""
  ].join("\r\n");
  const lifecycleRunnerPath = join(paths.home, "lifecycle-launcher.v1.ps1");
  const lifecycleVbsPath = join(paths.home, "lifecycle-launcher.v1.vbs");
  const lifecycleRunner = [
    "$ErrorActionPreference = 'Stop'",
    "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    `$env:LARK_CODEX_HUB_HOME = ${psLiteral(paths.home)}`,
    "$env:LARK_CODEX_HUB_SERVICE = '1'",
    `Set-Location -LiteralPath ${psLiteral(paths.installRoot)}`,
    "$ErrorActionPreference = 'Continue'",
    `& ${psLiteral(paths.nodeExecutable)} ${psLiteral(paths.cliFile)} lifecycle-event windows-power 2>> ${psLiteral(join(paths.home, "logs", "lifecycle.log"))}`,
    "$lifecycleExitCode = $LASTEXITCODE",
    "exit $lifecycleExitCode",
    ""
  ].join("\r\n");
  const lifecycleCommand = `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${lifecycleRunnerPath}"`;
  const lifecycleVbsCommand = lifecycleCommand.replaceAll('"', '""');
  const lifecycleVbs = [
    "Option Explicit",
    "Dim shell, exitCode",
    "Set shell = CreateObject(\"WScript.Shell\")",
    `exitCode = shell.Run("${lifecycleVbsCommand}", 0, True)`,
    "WScript.Quit exitCode",
    ""
  ].join("\r\n");
  return {
    runnerPath,
    vbsPath,
    runner,
    vbs,
    lifecycleRunnerPath,
    lifecycleVbsPath,
    lifecycleRunner,
    lifecycleVbs
  };
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
  await writeFile(
    launchers.lifecycleRunnerPath,
    `\uFEFF${launchers.lifecycleRunner}`,
    "utf8"
  );
  await writeFile(launchers.lifecycleVbsPath, launchers.lifecycleVbs, "ascii");

  const registerScript = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $request.execute -Argument $request.arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Days 3650) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName $request.taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
$eventCommand = '"' + $request.execute + '" //B //Nologo "' + $request.lifecycleVbsPath + '"'
$eventArgs = @(
  '/Create', '/TN', $request.lifecycleTaskName,
  '/TR', $eventCommand,
  '/SC', 'ONEVENT', '/EC', 'System',
  '/MO', "*[System[Provider[@Name='User32'] and EventID=1074]]",
  '/F', '/RL', 'LIMITED'
)
& schtasks.exe @eventArgs | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "注册 Windows 关机事件计划任务失败，退出码：$LASTEXITCODE"
}
`;
  await invokePowerShell(registerScript, {
    taskName,
    lifecycleTaskName,
    execute: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe"),
    arguments: `//B //Nologo "${launchers.vbsPath}"`,
    lifecycleVbsPath: launchers.lifecycleVbsPath
  });
}

export async function removeScheduledTask(): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
$name = ${psLiteral(taskName)}
$lifecycleName = ${psLiteral(lifecycleTaskName)}
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
}
if (Get-ScheduledTask -TaskName $lifecycleName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $lifecycleName -Confirm:$false
}
`;
  await invokePowerShell(script);
}

export async function startScheduledTask(): Promise<void> {
  const script = `
$ErrorActionPreference = 'Stop'
$name = ${psLiteral(taskName)}
Start-ScheduledTask -TaskName $name
$deadline = [DateTime]::UtcNow.AddSeconds(5)
do {
  Start-Sleep -Milliseconds 200
  $state = [string](Get-ScheduledTask -TaskName $name).State
} while ($state -ne 'Running' -and [DateTime]::UtcNow -lt $deadline)
if ($state -ne 'Running') {
  throw "计划任务未进入 Running 状态，当前状态：$state"
}
`;
  await invokePowerShell(script);
}

export interface ScheduledTaskStatus {
  installed: boolean;
  state?: string;
  lastRunTime?: string;
  lastTaskResult?: number;
  lifecycleInstalled: boolean;
  lifecycleState?: string;
  lifecycleLastRunTime?: string;
  lifecycleLastTaskResult?: number;
}

export async function scheduledTaskStatus(): Promise<ScheduledTaskStatus> {
  const script = `
$name = ${psLiteral(taskName)}
$lifecycleName = ${psLiteral(lifecycleTaskName)}
$task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
$lifecycleTask = Get-ScheduledTask -TaskName $lifecycleName -ErrorAction SilentlyContinue
$result = @{ installed = [bool]$task; lifecycleInstalled = [bool]$lifecycleTask }
if ($task) {
  $info = Get-ScheduledTaskInfo -TaskName $name
  $result.state = [string]$task.State
  $result.lastRunTime = if ($info.LastRunTime) { $info.LastRunTime.ToString('o') } else { $null }
  $result.lastTaskResult = [int]$info.LastTaskResult
}
if ($lifecycleTask) {
  $lifecycleInfo = Get-ScheduledTaskInfo -TaskName $lifecycleName
  $result.lifecycleState = [string]$lifecycleTask.State
  $result.lifecycleLastRunTime = if ($lifecycleInfo.LastRunTime) { $lifecycleInfo.LastRunTime.ToString('o') } else { $null }
  $result.lifecycleLastTaskResult = [int]$lifecycleInfo.LastTaskResult
}
$result | ConvertTo-Json -Compress
`;
  return JSON.parse(await invokePowerShell(script)) as ScheduledTaskStatus;
}
