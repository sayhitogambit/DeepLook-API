import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { AccountStore, AccountStoreError, type AccountLimits, type RequestStatus, type TokenAuthentication } from "./accountStore.js";
import type { OpenedPage } from "./browserProtocol.js";
import { BrowserCliError } from "./browserCli.js";
import { pageProblem } from "./pageResult.js";
import { defaultAddressResolver, UnsafeUrlError, validatePublicUrl, type AddressResolver } from "./security.js";

export type PageOpener = (url: string, timeoutMs: number, signal: AbortSignal) => Promise<OpenedPage>;
export type ApiServerOptions = {
  authorizationToken?: string;
  adminToken?: string;
  accountStore?: AccountStore;
  addressResolver?: AddressResolver;
  maxConcurrent?: number;
  launchSlackMs?: number;
};

const defaultTimeoutMs = 30_000;
const maxTimeoutMs = 120_000;
const maxBodyBytes = 65_536;
const defaultLaunchSlackMs = 20_000;
const legacyLimits: AccountLimits = { maxConcurrent: 2_147_483_647, monthlyRequestQuota: 2_147_483_647 };

export type ApiErrorCode = "invalid_request" | "navigation_failed" | "timeout" | "challenge" |
  "unauthorized" | "busy" | "quota_exceeded" | "not_found";

type ApiErrorBody = { error: ApiErrorCode; message: string; finalUrl?: string; title?: string; marker?: string };
type OpenInput = { ok: true; url: string; timeoutMs: number } | { ok: false; message: string };
type OpenIdentity = TokenAuthentication | { accountId: "legacy"; externalId: "legacy"; tokenId: "legacy"; limits: AccountLimits };
type PublicSession = { id: string; tokenId: string; hostname: string; startedAt: string };
type RuntimeSession = PublicSession & { externalId: string; month: string; controller: AbortController; quotaPending: boolean };
type RuntimeState = {
  maxConcurrent: number;
  active: number;
  activeByAccount: Map<string, number>;
  sessions: Map<string, RuntimeSession>;
};

class BodyTooLargeError extends Error {
  constructor() { super("Request body is too large."); this.name = "BodyTooLargeError"; }
}
class DeadlineError extends Error {
  constructor(timeoutMs: number) { super(`Timed out after ${timeoutMs}ms.`); this.name = "DeadlineError"; }
}

export function createApiServer(open: PageOpener, options: ApiServerOptions = {}): Server {
  const maxConcurrent = options.maxConcurrent ?? 2;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("maxConcurrent must be a positive integer.");
  const runtime: RuntimeState = { maxConcurrent, active: 0, activeByAccount: new Map(), sessions: new Map() };
  return createServer((request, response) => {
    void route(request, response, open, options, runtime).catch(() => sendError(response, "navigation_failed", "Unexpected server error."));
  });
}

async function route(request: IncomingMessage, response: ServerResponse, open: PageOpener, options: ApiServerOptions, runtime: RuntimeState): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (request.method === "GET" && path === "/health") { sendJson(response, 200, { ok: true }); return; }
  if (path.startsWith("/v1/admin/")) {
    if (options.accountStore === undefined || options.adminToken === undefined) { sendError(response, "not_found", "Not found."); return; }
    if (!hasBearerToken(request.headers.authorization, options.adminToken)) { sendError(response, "unauthorized", "A valid administrator bearer token is required."); return; }
    await managementRoute(request, response, url, options.accountStore, runtime);
    return;
  }
  if (request.method === "POST" && path === "/v1/open") {
    const identity = await authenticateOpen(request, options);
    if (identity === undefined) { sendError(response, "unauthorized", "A valid bearer token is required."); return; }
    await openRoute(request, response, open, options, runtime, identity);
    return;
  }
  sendError(response, "not_found", "Not found.");
}

async function authenticateOpen(request: IncomingMessage, options: ApiServerOptions): Promise<OpenIdentity | undefined> {
  const raw = bearerToken(request.headers.authorization);
  if (options.authorizationToken !== undefined && raw !== undefined && secretEquals(raw, options.authorizationToken)) {
    return { accountId: "legacy", externalId: "legacy", tokenId: "legacy", limits: legacyLimits };
  }
  if (raw !== undefined && options.accountStore !== undefined) return options.accountStore.authenticateToken(raw);
  if (options.authorizationToken === undefined && options.accountStore === undefined) {
    return { accountId: "legacy", externalId: "legacy", tokenId: "legacy", limits: legacyLimits };
  }
  return undefined;
}

async function openRoute(request: IncomingMessage, response: ServerResponse, open: PageOpener, options: ApiServerOptions, runtime: RuntimeState, identity: OpenIdentity): Promise<void> {
  let raw: string;
  try { raw = await readBody(request); }
  catch (cause) { sendError(response, "invalid_request", cause instanceof BodyTooLargeError ? cause.message : "Could not read the request body."); return; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { sendError(response, "invalid_request", "Request body must be JSON."); return; }
  const input = readOpenInput(parsed);
  if (!input.ok) { sendError(response, "invalid_request", input.message); return; }
  try { await validatePublicUrl(input.url, options.addressResolver ?? defaultAddressResolver); }
  catch (cause) { sendError(response, "invalid_request", cause instanceof UnsafeUrlError ? cause.message : "Could not validate URL."); return; }

  const usage = identity.externalId === "legacy" || options.accountStore === undefined
    ? { month: new Date().toISOString().slice(0, 7), requests: 0 }
    : await options.accountStore.getUsage(identity.externalId);
  const quotaPending = [...runtime.sessions.values()].filter((session) =>
    session.externalId === identity.externalId && session.month === usage.month && session.quotaPending).length;
  if (usage.requests + quotaPending >= identity.limits.monthlyRequestQuota) {
    sendError(response, "quota_exceeded", "The account monthly browser request quota has been reached."); return;
  }
  const accountActive = runtime.activeByAccount.get(identity.externalId) ?? 0;
  if (runtime.active >= runtime.maxConcurrent || accountActive >= identity.limits.maxConcurrent) {
    sendError(response, "busy", "Too many browser requests are active."); return;
  }

  const started = new Date();
  const session: RuntimeSession = {
    id: randomUUID(), tokenId: identity.tokenId, hostname: new URL(input.url).hostname.toLowerCase(),
    startedAt: started.toISOString(), externalId: identity.externalId, month: started.toISOString().slice(0, 7),
    controller: new AbortController(), quotaPending: true,
  };
  runtime.active += 1;
  response.setHeader("x-request-id", session.id);
  runtime.activeByAccount.set(identity.externalId, accountActive + 1);
  runtime.sessions.set(session.id, session);
  const operationSettled = () => {
    if (!runtime.sessions.has(session.id)) return;
    runtime.sessions.delete(session.id);
    runtime.active -= 1;
    const remaining = (runtime.activeByAccount.get(identity.externalId) ?? 1) - 1;
    if (remaining <= 0) runtime.activeByAccount.delete(identity.externalId);
    else runtime.activeByAccount.set(identity.externalId, remaining);
  };
  const finish = async (status: RequestStatus) => {
    if (!session.quotaPending) return;
    session.quotaPending = false;
    if (identity.externalId === "legacy" || options.accountStore === undefined) return;
    const completed = new Date();
    try {
      await options.accountStore.recordRequest(identity.externalId, {
        requestId: session.id, tokenId: identity.tokenId, hostname: session.hostname,
        startedAt: session.startedAt, completedAt: completed.toISOString(), durationMs: Math.max(0, completed.getTime() - started.getTime()), status,
      });
    } catch { /* telemetry must not replace the browser response */ }
  };

  try {
    const page = await openWithin(open, input.url, input.timeoutMs, request, response, options.launchSlackMs ?? defaultLaunchSlackMs, session.controller, operationSettled);
    await validatePublicUrl(page.finalUrl, options.addressResolver ?? defaultAddressResolver);
    const problem = pageProblem(page);
    if (problem?.kind === "challenge") { await finish("challenge"); sendError(response, "challenge", "The site returned a bot check instead of the page.", { finalUrl: page.finalUrl, title: page.title, marker: problem.marker }); return; }
    if (problem?.kind === "upstream_http") { await finish("navigation_failed"); sendError(response, "navigation_failed", `Upstream returned HTTP ${problem.status}.`, { finalUrl: page.finalUrl, title: page.title }); return; }
    await finish("succeeded");
    sendJson(response, 200, page);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Navigation failed.";
    if (cause instanceof BrowserCliError) {
      if (cause.code === "challenge") { await finish("challenge"); sendError(response, "challenge", cause.message, { finalUrl: cause.finalUrl, title: cause.title, marker: cause.marker }); return; }
      if (cause.code === "timeout") { await finish("timeout"); sendError(response, "timeout", cause.message); return; }
      await finish("navigation_failed"); sendError(response, "navigation_failed", cause.message, { finalUrl: cause.finalUrl, title: cause.title }); return;
    }
    if (isTimeout(cause)) { await finish("timeout"); sendError(response, "timeout", message); return; }
    await finish(session.controller.signal.aborted ? "canceled" : "navigation_failed");
    sendError(response, "navigation_failed", message);
  }
}

async function managementRoute(request: IncomingMessage, response: ServerResponse, url: URL, store: AccountStore, runtime: RuntimeState): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length < 4 || parts[0] !== "v1" || parts[1] !== "admin" || parts[2] !== "accounts") { sendError(response, "not_found", "Not found."); return; }
  const externalId = parts[3]!;
  try {
    if (parts.length === 4 && request.method === "PUT") {
      const account = await store.ensureAccount(externalId, readAccountInput(await readJsonObject(request)));
      sendJson(response, 200, { account: await accountResponse(account, store) }); return;
    }
    if (parts.length === 4 && request.method === "GET") {
      const account = await requirePublicAccount(store, externalId);
      sendJson(response, 200, { account: await accountResponse(account, store) }); return;
    }
    if (parts[4] === "tokens" && parts.length === 5 && request.method === "GET") { sendJson(response, 200, { tokens: await store.listTokens(externalId) }); return; }
    if (parts[4] === "tokens" && parts.length === 5 && request.method === "POST") {
      const name = (await readJsonObject(request)).name;
      if (typeof name !== "string") throw new AccountStoreError("invalid_request", "name must be a string.");
      sendJson(response, 201, await store.createToken(externalId, name)); return;
    }
    if (parts[4] === "tokens" && parts.length === 7 && parts[6] === "rotate" && request.method === "POST") { sendJson(response, 200, await store.rotateToken(externalId, parts[5]!)); return; }
    if (parts[4] === "tokens" && parts.length === 6 && request.method === "DELETE") { await store.revokeToken(externalId, parts[5]!); sendEmpty(response, 204); return; }
    if (parts[4] === "usage" && parts.length === 5 && request.method === "GET") {
      const account = await requirePublicAccount(store, externalId);
      sendJson(response, 200, { usage: withRemaining(await store.getUsage(externalId), account.limits.monthlyRequestQuota) }); return;
    }
    if (parts[4] === "logs" && parts.length === 5 && request.method === "GET") {
      const rawLimit = url.searchParams.get("limit");
      sendJson(response, 200, { logs: await store.getLogs(externalId, rawLimit === null ? 100 : Number(rawLimit)) }); return;
    }
    if (parts[4] === "sessions" && parts.length === 5 && request.method === "GET") {
      await requirePublicAccount(store, externalId);
      sendJson(response, 200, { sessions: accountSessions(runtime, externalId).map(publicSession) }); return;
    }
    if (parts[4] === "sessions" && parts.length === 6 && request.method === "DELETE") {
      await requirePublicAccount(store, externalId);
      const session = runtime.sessions.get(parts[5]!);
      if (session === undefined || session.externalId !== externalId) throw new AccountStoreError("not_found", "Session not found.");
      session.controller.abort(new Error("Browser request was canceled by an administrator."));
      sendJson(response, 202, { canceled: true }); return;
    }
    if (parts[4] === "pressure" && parts.length === 5 && request.method === "GET") {
      const account = await requirePublicAccount(store, externalId);
      const usage = await store.getUsage(externalId);
      const sessions = accountSessions(runtime, externalId);
      const pending = sessions.filter((session) => session.quotaPending && session.month === usage.month).length;
      const accountRemainingConcurrent = Math.max(0, account.limits.maxConcurrent - sessions.length);
      const globalRemainingConcurrent = Math.max(0, runtime.maxConcurrent - runtime.active);
      sendJson(response, 200, { pressure: {
        active: sessions.length, maxConcurrent: account.limits.maxConcurrent,
        remainingConcurrent: Math.min(accountRemainingConcurrent, globalRemainingConcurrent), requests: usage.requests,
        monthlyRequestQuota: account.limits.monthlyRequestQuota,
        remainingRequests: Math.max(0, account.limits.monthlyRequestQuota - usage.requests - pending),
        globalActive: runtime.active, globalMaxConcurrent: runtime.maxConcurrent,
        globalRemainingConcurrent,
      } }); return;
    }
    sendError(response, "not_found", "Not found.");
  } catch (cause) {
    if (cause instanceof BodyTooLargeError || cause instanceof SyntaxError) { sendError(response, "invalid_request", cause.message); return; }
    if (cause instanceof AccountStoreError) { sendError(response, cause.code, cause.message); return; }
    throw cause;
  }
}

async function accountResponse(account: Awaited<ReturnType<AccountStore["ensureAccount"]>>, store: AccountStore) {
  return { ...account, usage: withRemaining(await store.getUsage(account.externalId), account.limits.monthlyRequestQuota) };
}
function withRemaining<T extends { requests: number }>(usage: T, quota: number) { return { ...usage, remaining: Math.max(0, quota - usage.requests) }; }
async function requirePublicAccount(store: AccountStore, externalId: string) {
  const account = await store.getAccount(externalId);
  if (account === undefined) throw new AccountStoreError("not_found", "Account not found.");
  return account;
}
function accountSessions(runtime: RuntimeState, externalId: string): RuntimeSession[] { return [...runtime.sessions.values()].filter((session) => session.externalId === externalId); }
function publicSession(session: RuntimeSession): PublicSession { return { id: session.id, tokenId: session.tokenId, hostname: session.hostname, startedAt: session.startedAt }; }

function readAccountInput(body: Record<string, unknown>): { name?: string; limits?: Partial<AccountLimits> } {
  if (body.name !== undefined && typeof body.name !== "string") throw new AccountStoreError("invalid_request", "name must be a string.");
  if (body.limits !== undefined && (body.limits === null || typeof body.limits !== "object" || Array.isArray(body.limits))) throw new AccountStoreError("invalid_request", "limits must be an object.");
  const limits = body.limits as Record<string, unknown> | undefined;
  return {
    ...(body.name === undefined ? {} : { name: body.name as string }),
    ...(limits === undefined ? {} : { limits: {
      ...(limits.maxConcurrent === undefined ? {} : { maxConcurrent: limits.maxConcurrent as number }),
      ...(limits.monthlyRequestQuota === undefined ? {} : { monthlyRequestQuota: limits.monthlyRequestQuota as number }),
    } }),
  };
}

function readOpenInput(value: unknown): OpenInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, message: "Request body must be a JSON object." };
  const body = value as { url?: unknown; timeoutMs?: unknown };
  if (typeof body.url !== "string" || body.url.trim() !== body.url) return { ok: false, message: 'Expected a string "url".' };
  let parsed: URL;
  try { parsed = new URL(body.url); } catch { return { ok: false, message: "url must be an absolute http(s) URL." }; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, message: "url must be an absolute http(s) URL." };
  if (body.timeoutMs === undefined) return { ok: true, url: body.url, timeoutMs: defaultTimeoutMs };
  if (typeof body.timeoutMs !== "number" || !Number.isInteger(body.timeoutMs) || body.timeoutMs < 1 || body.timeoutMs > maxTimeoutMs) return { ok: false, message: `timeoutMs must be an integer from 1 to ${maxTimeoutMs}.` };
  return { ok: true, url: body.url, timeoutMs: body.timeoutMs };
}

function openWithin(open: PageOpener, url: string, timeoutMs: number, request: IncomingMessage, response: ServerResponse, slackMs: number, controller: AbortController, onOperationSettled: () => void): Promise<OpenedPage> {
  const deadlineMs = timeoutMs + slackMs;
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const cleanupWait = () => { clearTimeout(timer); response.off("close", onDisconnect); controller.signal.removeEventListener("abort", onAbort); };
    const onAbort = () => { cleanupWait(); reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error("Browser request was canceled.")); };
    const onDisconnect = () => controller.abort(new Error("Client disconnected."));
    response.once("close", onDisconnect);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => controller.abort(new DeadlineError(deadlineMs)), deadlineMs);
    if (request.destroyed && !request.complete) controller.abort(new Error("Client disconnected."));
    Promise.resolve().then(() => open(url, timeoutMs, controller.signal)).then(
      (page) => { cleanupWait(); onOperationSettled(); resolve(page); },
      (cause: unknown) => { cleanupWait(); onOperationSettled(); reject(cause); },
    );
  });
}

function bearerToken(raw: string | undefined): string | undefined { return /^Bearer (\S+)$/.exec(raw ?? "")?.[1]; }
function hasBearerToken(raw: string | undefined, expected: string): boolean { const token = bearerToken(raw); return token !== undefined && secretEquals(token, expected); }
function secretEquals(provided: string, expected: string): boolean { const left = Buffer.from(provided); const right = Buffer.from(expected); return left.length === right.length && timingSafeEqual(left, right); }
function isTimeout(cause: unknown): boolean { return cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "DeadlineError" || /Timeout \d+ms exceeded/i.test(cause.message)); }

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(request);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new SyntaxError("Request body must be JSON."); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new AccountStoreError("invalid_request", "Request body must be a JSON object.");
  return value as Record<string, unknown>;
}

function readBody(request: IncomingMessage): Promise<string> {
  const declared = request.headers["content-length"];
  if (declared !== undefined && Number(declared) > maxBodyBytes) { request.resume(); return Promise.reject(new BodyTooLargeError()); }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maxBodyBytes) { reject(new BodyTooLargeError()); request.removeAllListeners("data"); request.resume(); return; } chunks.push(chunk); });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => reject(new Error("Could not read the request body.")));
  });
}

function sendError(response: ServerResponse, code: ApiErrorCode, message: string, extra?: Pick<ApiErrorBody, "finalUrl" | "title" | "marker">): void { sendJson(response, statusFor(code), { error: code, message, ...extra }); }
function statusFor(code: ApiErrorCode): number {
  switch (code) {
    case "invalid_request": return 400;
    case "navigation_failed": return 502;
    case "timeout": return 504;
    case "challenge": return 422;
    case "unauthorized": return 401;
    case "quota_exceeded": return 429;
    case "busy": return 503;
    case "not_found": return 404;
  }
}
function sendEmpty(response: ServerResponse, status: number): void { if (!response.destroyed && !response.writableEnded) { response.writeHead(status, { "cache-control": "no-store" }); response.end(); } }
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload), "cache-control": "no-store" });
  response.end(payload);
}
