import type { SecretName, SecretVault } from "../../ports/secret-vault.js";

const names: Record<SecretName, string> = {
  "feishu.app_id": "LARK_APP_ID",
  "feishu.app_secret": "LARK_APP_SECRET"
};

export class EnvironmentVault implements SecretVault {
  public async get(name: SecretName): Promise<string | undefined> {
    return process.env[names[name]];
  }

  public async set(): Promise<void> {
    throw new Error("环境变量密钥库是只读的。请设置 LARK_APP_ID 和 LARK_APP_SECRET。");
  }

  public async delete(): Promise<void> {
    throw new Error("环境变量密钥库不支持删除操作。");
  }
}
