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
  if (
    legacy.schemaVersion !== 2 &&
    legacy.schemaVersion !== 3 &&
    legacy.schemaVersion !== 4 &&
    legacy.schemaVersion !== 5
  ) {
    throw new Error(`不支持的配置版本：${String(legacy.schemaVersion)}`);
  }
  const {
    workspace: _workspace,
    vscode: _vscode,
    schemaVersion: _schemaVersion,
    ...rest
  } = legacy;
  const projects = legacy.projects && typeof legacy.projects === "object"
    ? legacy.projects as Record<string, unknown>
    : {};
  const notifications = legacy.notifications && typeof legacy.notifications === "object"
    ? legacy.notifications as Record<string, unknown>
    : {};
  return hubConfigSchema.parse({
    ...rest,
    schemaVersion: 6,
    projects: {
      cacheSeconds: projects.cacheSeconds ?? 30,
      pendingPromptMinutes: projects.pendingPromptMinutes ?? 30
    },
    notifications: {
      ...notifications,
      lifecycle: notifications.lifecycle ?? {
        mode: "all",
        heartbeatSeconds: 30
      }
    }
  });
}

export class FileConfigStore {
  public readonly path: string;
  private readonly legacyPaths: readonly string[];

  public constructor(home: string) {
    this.path = join(home, "config.v6.json");
    this.legacyPaths = [
      join(home, "config.v5.json"),
      join(home, "config.v4.json"),
      join(home, "config.v3.json"),
      join(home, "config.v2.json")
    ];
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
    for (const legacyPath of this.legacyPaths) {
      try {
        const legacyRaw = await readFile(legacyPath, "utf8");
        const migrated = migrateLegacyConfig(JSON.parse(legacyRaw));
        await this.save(migrated);
        await rm(legacyPath, { force: true });
        return migrated;
      } catch (error) {
        if (!isNotFound(error)) {
          throw error;
        }
      }
    }
    throw new Error("未找到 Lark Codex Hub 配置，请先执行 setup。");
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
