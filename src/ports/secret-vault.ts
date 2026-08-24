export type SecretName = "feishu.app_id" | "feishu.app_secret";

export interface SecretVault {
  get(name: SecretName): Promise<string | undefined>;
  set(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<void>;
}
