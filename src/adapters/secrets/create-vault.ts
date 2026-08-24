import type { SecretVault } from "../../ports/secret-vault.js";
import { EnvironmentVault } from "./env-vault.js";
import { WindowsDpapiVault } from "../windows/dpapi-vault.js";

export function createSecretVault(home: string): SecretVault {
  if (process.env.LARK_APP_ID && process.env.LARK_APP_SECRET) {
    return new EnvironmentVault();
  }
  if (process.platform === "win32") {
    return new WindowsDpapiVault(home);
  }
  return new EnvironmentVault();
}
