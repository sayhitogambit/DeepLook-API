import { statSync } from "node:fs";
import { isAbsolute } from "node:path";

export type ServeConfig = {
  host: string;
  port: number;
  authorizationToken: string | undefined;
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
  if (host !== "127.0.0.1" && host !== "::1" && authorizationToken === undefined) {
    throw new Error("DEEPLOOK_API_TOKEN is required when DEEPLOOK_HOST is not loopback.");
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
  return { host, port, authorizationToken, browserCliPath };
}
