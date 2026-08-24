import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SecretName, SecretVault } from "../../ports/secret-vault.js";

interface VaultDocument {
  version: 1;
  values: Partial<Record<SecretName, string>>;
}

const script = String.raw`
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Security
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$bytes = [Convert]::FromBase64String([string]$request.value)
if ($request.operation -eq 'protect') {
  $result = [System.Security.Cryptography.ProtectedData]::Protect(
    $bytes,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
} elseif ($request.operation -eq 'unprotect') {
  $result = [System.Security.Cryptography.ProtectedData]::Unprotect(
    $bytes,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
} else {
  throw 'Unsupported operation'
}
[Console]::Out.Write([Convert]::ToBase64String($result))
`;

async function invokeDpapi(operation: "protect" | "unprotect", value: Buffer): Promise<Buffer> {
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
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Windows DPAPI 调用失败：${stderr.trim() || `exit ${String(code)}`}`));
        return;
      }
      try {
        resolve(Buffer.from(stdout.trim(), "base64"));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(
      JSON.stringify({ operation, value: value.toString("base64") }),
      "utf8"
    );
  });
}

export class WindowsDpapiVault implements SecretVault {
  private readonly path: string;

  public constructor(home: string) {
    if (process.platform !== "win32") {
      throw new Error("WindowsDpapiVault 只能在 Windows 上使用。");
    }
    this.path = join(home, "secrets.v2.json");
  }

  public async get(name: SecretName): Promise<string | undefined> {
    const document = await this.read();
    const encrypted = document.values[name];
    if (!encrypted) {
      return undefined;
    }
    const clear = await invokeDpapi("unprotect", Buffer.from(encrypted, "base64"));
    return clear.toString("utf8");
  }

  public async set(name: SecretName, value: string): Promise<void> {
    if (!value) {
      throw new Error(`密钥 ${name} 不能为空。`);
    }
    const document = await this.read();
    const encrypted = await invokeDpapi("protect", Buffer.from(value, "utf8"));
    document.values[name] = encrypted.toString("base64");
    await this.write(document);
  }

  public async delete(name: SecretName): Promise<void> {
    const document = await this.read();
    delete document.values[name];
    await this.write(document);
  }

  private async read(): Promise<VaultDocument> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<VaultDocument>;
      if (parsed.version !== 1 || !parsed.values || typeof parsed.values !== "object") {
        throw new Error("密钥库格式无效。");
      }
      return { version: 1, values: parsed.values };
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "ENOENT") {
        return { version: 1, values: {} };
      }
      throw error;
    }
  }

  private async write(document: VaultDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporary, this.path);
  }
}
