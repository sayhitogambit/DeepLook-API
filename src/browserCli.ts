import { spawn } from "node:child_process";

import type { BrowserEnvelope, BrowserErrorCode, OpenedPage } from "./browserProtocol.js";

const maxStdoutBytes = 2_000_000;
const maxStderrBytes = 8_192;
const terminationGraceMs = 2_000;

export class BrowserCliError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message: string,
    readonly finalUrl?: string,
    readonly title?: string,
    readonly marker?: string,
  ) {
    super(message);
    this.name = code === "timeout" ? "TimeoutError" : "BrowserCliError";
  }
}

export function createBrowserCliOpener(cliPath: string) {
  return (url: string, timeoutMs: number, signal: AbortSignal): Promise<OpenedPage> => {
    if (signal.aborted) return Promise.reject(new Error("Browser request was canceled."));
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath,
        [cliPath, "open", url, "--machine", "--timeout-ms", String(timeoutMs)],
        { stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let canceled = false;
      let tooLarge = false;
      let launchError: Error | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const terminate = () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        forceKillTimer ??= setTimeout(() => child.kill("SIGKILL"), terminationGraceMs);
        forceKillTimer.unref();
      };
      const onAbort = () => {
        canceled = true;
        terminate();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxStdoutBytes) {
          tooLarge = true;
          terminate();
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > maxStderrBytes) terminate();
      });
      child.once("error", (cause: Error) => { launchError = cause; });
      child.once("close", (exitCode) => {
        signal.removeEventListener("abort", onAbort);
        if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
        if (canceled) { reject(new Error("Browser request was canceled.")); return; }
        if (tooLarge || stderrBytes > maxStderrBytes || launchError !== undefined) {
          reject(new Error("Invalid browser response."));
          return;
        }
        let result: BrowserEnvelope;
        try {
          result = JSON.parse(Buffer.concat(stdout).toString("utf8")) as BrowserEnvelope;
        } catch {
          reject(new Error("Invalid browser response."));
          return;
        }
        if (!isEnvelope(result)) {
          reject(new Error("Invalid browser response."));
          return;
        }
        if (result.ok && exitCode === 0) { resolve(result.page); return; }
        if (!result.ok && exitCode !== 0) {
          reject(new BrowserCliError(result.error, result.message,
            result.finalUrl, result.title, result.marker));
          return;
        }
        reject(new Error("Invalid browser response."));
      });
    });
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isEnvelope(value: unknown): value is BrowserEnvelope {
  if (!isRecord(value) || value.version !== 1 || typeof value.ok !== "boolean") return false;
  if (value.ok) {
    if (!isRecord(value.page)) return false;
    const page = value.page;
    if (!isRecord(page.observed)) return false;
    const observed = page.observed;
    if (!isRecord(observed.viewport)) return false;
    const viewport = observed.viewport;
    return typeof page.requestedUrl === "string" && typeof page.finalUrl === "string" &&
      (page.httpStatus === undefined || typeof page.httpStatus === "number") &&
      typeof page.title === "string" && typeof page.text === "string" &&
      typeof page.truncated === "boolean" && typeof observed.webdriver === "boolean" &&
      typeof observed.userAgent === "string" && isStringArray(observed.brands) &&
      isStringArray(observed.languages) && typeof observed.timezone === "string" &&
      typeof viewport.width === "number" && typeof viewport.height === "number";
  }
  return isErrorCode(value.error) && typeof value.message === "string" &&
    (value.finalUrl === undefined || typeof value.finalUrl === "string") &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.marker === undefined || typeof value.marker === "string");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isErrorCode(value: unknown): value is BrowserErrorCode {
  return value === "challenge" || value === "upstream_http" ||
    value === "timeout" || value === "navigation_failed";
}
