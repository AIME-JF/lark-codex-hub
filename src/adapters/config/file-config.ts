import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hubConfigSchema, type HubConfig } from "../../contracts/config.js";

export class FileConfigStore {
  public readonly path: string;

  public constructor(home: string) {
    this.path = join(home, "config.v2.json");
  }

  public async load(): Promise<HubConfig> {
    const raw = await readFile(this.path, "utf8");
    return hubConfigSchema.parse(JSON.parse(raw));
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
