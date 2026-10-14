import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type ServeConfig = {
  host: string;
  port: number;
  authorizationToken: string | undefined;
  adminToken: string | undefined;
  dataDir: string;
  maxConcurrent: number;
  browserCliPath: string;
};

export function readServeConfig(env: NodeJS.ProcessEnv): ServeConfig {
  const host = env.DEEPLOOK_HOST || "127.0.0.1";
  const rawPort = env.DEEPLOOK_PORT;
  const port = rawPort === undefined || rawPort === "" ? 47_231 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DEEPLOOK_PORT must be an integer from 1 to 65535.");
  }
  const authorizationToken = env.DEEPLOOK_API_TOKEN || undefined;
  const adminToken = env.DEEPLOOK_ADMIN_TOKEN || undefined;
  validateSecret("DEEPLOOK_API_TOKEN", authorizationToken);
  validateSecret("DEEPLOOK_ADMIN_TOKEN", adminToken);
  if (authorizationToken !== undefined && adminToken !== undefined && authorizationToken === adminToken) {
    throw new Error("DEEPLOOK_API_TOKEN and DEEPLOOK_ADMIN_TOKEN must be different secrets.");
  }
  if (host !== "127.0.0.1" && host !== "::1" && authorizationToken === undefined && adminToken === undefined) {
    throw new Error("DEEPLOOK_API_TOKEN or DEEPLOOK_ADMIN_TOKEN is required when DEEPLOOK_HOST is not loopback.");
  }
  const browserCliPath = env.DEEPLOOK_CLI_PATH;
  if (browserCliPath === undefined || !isAbsolute(browserCliPath)) {
    throw new Error("DEEPLOOK_CLI_PATH must be an absolute path to the built DeepLook browser CLI.");
  }
  try {
    if (!statSync(browserCliPath).isFile()) throw new Error("not a file");
  } catch {
    throw new Error("DEEPLOOK_CLI_PATH must point to an existing browser CLI file.");
  }
  const dataDir = resolve(env.DEEPLOOK_DATA_DIR || "data");
  const rawMaxConcurrent = env.DEEPLOOK_MAX_CONCURRENT;
  const maxConcurrent = rawMaxConcurrent === undefined || rawMaxConcurrent === "" ? 2 : Number(rawMaxConcurrent);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 100) {
    throw new Error("DEEPLOOK_MAX_CONCURRENT must be an integer from 1 to 100.");
  }
  return { host, port, authorizationToken, adminToken, dataDir, maxConcurrent, browserCliPath };
}

function validateSecret(name: string, value: string | undefined): void {
  if (value !== undefined && (value.length < 32 || value.length > 512 || /\s/.test(value))) {
    throw new Error(`${name} must contain 32-512 non-whitespace characters.`);
  }
}
