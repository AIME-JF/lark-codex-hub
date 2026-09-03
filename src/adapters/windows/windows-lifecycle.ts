import type { WindowsPowerEvent } from "../../contracts/lifecycle.js";
import { invokePowerShell } from "./powershell.js";

interface RawPowerEvent {
  recordId: number;
  occurredAt: string;
  message: string;
}

export async function windowsBootId(): Promise<string> {
  if (process.platform !== "win32") {
    return `process:${String(Date.now() - Math.round(process.uptime() * 1_000))}`;
  }
  return invokePowerShell(
    "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')"
  );
}

export async function latestWindowsPowerEvent(): Promise<WindowsPowerEvent | undefined> {
  if (process.platform !== "win32") {
    return undefined;
  }
  const output = await invokePowerShell(String.raw`
$event = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'User32'; Id = 1074 } -MaxEvents 1 -ErrorAction SilentlyContinue
if ($event) {
  @{
    recordId = [long]$event.RecordId
    occurredAt = $event.TimeCreated.ToUniversalTime().ToString('o')
    message = [string]$event.Message
  } | ConvertTo-Json -Compress
}
`);
  if (!output) {
    return undefined;
  }
  const raw = JSON.parse(output) as RawPowerEvent;
  const restart = /(?:重启|重新启动|restart)/iu.test(raw.message);
  return {
    key: `windows-user32-1074:${String(raw.recordId)}`,
    kind: restart ? "system_restart" : "system_shutdown",
    occurredAt: new Date(raw.occurredAt).getTime(),
    message: raw.message
  };
}
