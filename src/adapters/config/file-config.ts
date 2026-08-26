import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hubConfigSchema, type HubConfig } from "../../contracts/config.js";

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function migrateLegacyConfig(value: unknown): HubConfig {
  if (!value || typeof value !== "object") {
    throw new Error("旧配置不是有效的 JSON 对象。");
  }
  const legacy = value as Record<string, unknown>;
  if (legacy.schemaVersion !== 2) {
    throw new Error(`不支持的配置版本：${String(legacy.schemaVersion)}`);
  }
  const { workspace: _workspace, schemaVersion: _schemaVersion, ...rest } = legacy;
  return hubConfigSchema.parse({
    ...rest,
    schemaVersion: 3,
    projects: {
      sourceKinds: ["vscode", "appServer"],
      cacheSeconds: 30,
      pendingPromptMinutes: 30
    }
  });
}

export class FileConfigStore {
  public readonly path: string;
  private readonly legacyPath: string;

  public constructor(home: string) {
    this.path = join(home, "config.v3.json");
    this.legacyPath = join(home, "config.v2.json");
  }

  public async load(): Promise<HubConfig> {
    try {
      const raw = await readFile(this.path, "utf8");
      return hubConfigSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
    }
    const legacyRaw = await readFile(this.legacyPath, "utf8");
    const migrated = migrateLegacyConfig(JSON.parse(legacyRaw));
    await this.save(migrated);
    await rm(this.legacyPath, { force: true });
    return migrated;
  }

  public async save(config: HubConfig): Promise<void> {
    const valid = hubConfigSchema.parse(config);
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(valid, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporary, this.path);
  }
}
