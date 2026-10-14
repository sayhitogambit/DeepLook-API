import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountStore } from "./accountStore.js";
import type { OpenedPage } from "./browserProtocol.js";
import type { AddressResolver } from "./security.js";
import { createApiServer, type PageOpener } from "./server.js";

const adminToken = "admin-fixture-secret";
const publicResolver: AddressResolver = async () => [{ address: "93.184.216.34", family: 4 }];
const page = (url = "https://example.com/private/path?secret=yes"): OpenedPage => ({
  requestedUrl: url,
  finalUrl: url,
  title: "Example",
  text: "Example",
  truncated: false,
  observed: { webdriver: false, userAgent: "Chrome", brands: [], languages: ["en-US"], timezone: "UTC", viewport: { width: 1366, height: 768 } },
});

async function fixture(open: PageOpener = async (url) => page(url)) {
  const directory = await mkdtemp(join(tmpdir(), "deeplook-management-"));
  const store = new AccountStore(directory);
  const server = createApiServer(open, { addressResolver: publicResolver, adminToken, accountStore: store });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { directory, store, server, base: `http://127.0.0.1:${address.port}` };
}

const admin = { authorization: `Bearer ${adminToken}`, "content-type": "application/json" };
async function cleanup(server: Server, directory: string) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(directory, { recursive: true, force: true });
}

test("management routes are admin-only and account summaries are tenant-scoped", async () => {
  const { server, base, directory } = await fixture();
  try {
    const denied = await fetch(`${base}/v1/admin/accounts/tenant-a`);
    assert.equal(denied.status, 401);
    const created = await fetch(`${base}/v1/admin/accounts/tenant-a`, {
      method: "PUT", headers: admin,
      body: JSON.stringify({ name: "Tenant A", limits: { maxConcurrent: 2, monthlyRequestQuota: 5 } }),
    });
    assert.equal(created.status, 200);
    const body = await created.json() as { account: { externalId: string; name: string; limits: unknown; usage: { requests: number } } };
    assert.equal(body.account.externalId, "tenant-a");
    assert.equal(body.account.name, "Tenant A");
    assert.deepEqual(body.account.limits, { maxConcurrent: 2, monthlyRequestQuota: 5 });
    assert.equal(body.account.usage.requests, 0);

    await fetch(`${base}/v1/admin/accounts/tenant-b`, { method: "PUT", headers: admin, body: "{}" });
    const a = await fetch(`${base}/v1/admin/accounts/tenant-a`, { headers: admin });
    assert.equal(JSON.stringify(await a.json()).includes("tenant-b"), false);
  } finally { await cleanup(server, directory); }
});

test("browser keys are returned once and token management stays within the requested account", async () => {
  const { server, base, directory } = await fixture();
  try {
    for (const id of ["tenant-a", "tenant-b"]) {
      await fetch(`${base}/v1/admin/accounts/${id}`, { method: "PUT", headers: admin, body: "{}" });
    }
    const created = await fetch(`${base}/v1/admin/accounts/tenant-a/tokens`, {
      method: "POST", headers: admin, body: JSON.stringify({ name: "Production" }),
    });
    assert.equal(created.status, 201);
    const first = await created.json() as { token: { id: string; name: string }; secret: string };
    assert.match(first.secret, /^dlk_[A-Za-z0-9_-]{43}$/);

    const list = await fetch(`${base}/v1/admin/accounts/tenant-a/tokens`, { headers: admin });
    const listed = await list.json() as { tokens: unknown[] };
    assert.equal(listed.tokens.length, 1);
    assert.equal(JSON.stringify(listed).includes(first.secret), false);

    const crossTenant = await fetch(`${base}/v1/admin/accounts/tenant-b/tokens/${first.token.id}/rotate`, {
      method: "POST", headers: admin,
    });
    assert.equal(crossTenant.status, 404);

    const rotatedResponse = await fetch(`${base}/v1/admin/accounts/tenant-a/tokens/${first.token.id}/rotate`, {
      method: "POST", headers: admin,
    });
    assert.equal(rotatedResponse.status, 200);
    const rotated = await rotatedResponse.json() as { secret: string };
    assert.notEqual(rotated.secret, first.secret);
    const oldDenied = await fetch(`${base}/v1/open`, { method: "POST", headers: { authorization: `Bearer ${first.secret}` }, body: JSON.stringify({ url: "https://example.com" }) });
    assert.equal(oldDenied.status, 401);
    const newAllowed = await fetch(`${base}/v1/open`, { method: "POST", headers: { authorization: `Bearer ${rotated.secret}` }, body: JSON.stringify({ url: "https://example.com" }) });
    assert.equal(newAllowed.status, 200);

    assert.equal((await fetch(`${base}/v1/admin/accounts/tenant-a/tokens/${first.token.id}`, { method: "DELETE", headers: admin })).status, 204);
    assert.equal((await fetch(`${base}/v1/open`, { method: "POST", headers: { authorization: `Bearer ${rotated.secret}` }, body: JSON.stringify({ url: "https://example.com" }) })).status, 401);
  } finally { await cleanup(server, directory); }
});

test("usage and logs attribute opens without retaining URL paths", async () => {
  const { server, base, directory } = await fixture();
  try {
    await fetch(`${base}/v1/admin/accounts/tenant-a`, { method: "PUT", headers: admin, body: "{}" });
    const keyResponse = await fetch(`${base}/v1/admin/accounts/tenant-a/tokens`, { method: "POST", headers: admin, body: JSON.stringify({ name: "Key" }) });
    const key = await keyResponse.json() as { secret: string; token: { id: string } };
    const opened = await fetch(`${base}/v1/open`, { method: "POST", headers: { authorization: `Bearer ${key.secret}` }, body: JSON.stringify({ url: "https://example.com/private/path?secret=yes" }) });
    assert.equal(opened.status, 200);
    const requestId = opened.headers.get("x-request-id");
    assert.ok(requestId);

    const usage = await (await fetch(`${base}/v1/admin/accounts/tenant-a/usage`, { headers: admin })).json() as { usage: { requests: number; succeeded: number } };
    assert.equal(usage.usage.requests, 1);
    assert.equal(usage.usage.succeeded, 1);
    const logs = await (await fetch(`${base}/v1/admin/accounts/tenant-a/logs`, { headers: admin })).json() as { logs: Array<Record<string, unknown>> };
    assert.equal(logs.logs.length, 1);
    assert.equal(logs.logs[0]?.hostname, "example.com");
    assert.equal(logs.logs[0]?.tokenId, key.token.id);
    assert.equal(logs.logs[0]?.requestId, requestId);
    assert.equal(typeof logs.logs[0]?.durationMs, "number");
    assert.equal(JSON.stringify(logs).includes("private/path"), false);
  } finally { await cleanup(server, directory); }
});

test("per-account concurrency, monthly quota, pressure, sessions, and cancellation are enforced", async () => {
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const open: PageOpener = async (url, _timeout, signal) => {
    firstStarted();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new Error("canceled");
  };
  const { server, base, directory } = await fixture(open);
  try {
    await fetch(`${base}/v1/admin/accounts/tenant-a`, { method: "PUT", headers: admin, body: JSON.stringify({ limits: { maxConcurrent: 1, monthlyRequestQuota: 1 } }) });
    await fetch(`${base}/v1/admin/accounts/tenant-b`, { method: "PUT", headers: admin, body: "{}" });
    const key = await (await fetch(`${base}/v1/admin/accounts/tenant-a/tokens`, { method: "POST", headers: admin, body: JSON.stringify({ name: "Key" }) })).json() as { secret: string };
    const request = fetch(`${base}/v1/open`, { method: "POST", headers: { authorization: `Bearer ${key.secret}` }, body: JSON.stringify({ url: "https://example.com" }) });
    await started;

    const sessions = await (await fetch(`${base}/v1/admin/accounts/tenant-a/sessions`, { headers: admin })).json() as { sessions: Array<{ id: string }> };
    assert.equal(sessions.sessions.length, 1);
    const pressure = await (await fetch(`${base}/v1/admin/accounts/tenant-a/pressure`, { headers: admin })).json() as { pressure: { active: number; remainingConcurrent: number; remainingRequests: number } };
    assert.deepEqual({ active: pressure.pressure.active, remainingConcurrent: pressure.pressure.remainingConcurrent, remainingRequests: pressure.pressure.remainingRequests }, { active: 1, remainingConcurrent: 0, remainingRequests: 0 });

    const busy = await fetch(`${base}/v1/open`, { method: "POST", headers: { authorization: `Bearer ${key.secret}` }, body: JSON.stringify({ url: "https://example.com" }) });
    assert.equal(busy.status, 429);
    assert.equal((await busy.json() as { error: string }).error, "quota_exceeded");

    const crossTenantCancel = await fetch(`${base}/v1/admin/accounts/tenant-b/sessions/${sessions.sessions[0]!.id}`, { method: "DELETE", headers: admin });
    assert.equal(crossTenantCancel.status, 404);

    const canceled = await fetch(`${base}/v1/admin/accounts/tenant-a/sessions/${sessions.sessions[0]!.id}`, { method: "DELETE", headers: admin });
    assert.equal(canceled.status, 202);
    assert.deepEqual(await canceled.json(), { canceled: true });
    assert.equal((await request).status, 502);
  } finally { await cleanup(server, directory); }
});

test("pressure and admission cap account capacity by the global browser limit", async () => {
  let starts = 0;
  let bothStarted!: () => void;
  const started = new Promise<void>((resolve) => { bothStarted = resolve; });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const { server, base, directory } = await fixture(async (url) => {
    starts += 1;
    if (starts === 2) bothStarted();
    await hold;
    return page(url);
  });
  try {
    await fetch(`${base}/v1/admin/accounts/tenant-a`, {
      method: "PUT", headers: admin,
      body: JSON.stringify({ limits: { maxConcurrent: 10, monthlyRequestQuota: 10 } }),
    });
    const key = await (await fetch(`${base}/v1/admin/accounts/tenant-a/tokens`, {
      method: "POST", headers: admin, body: JSON.stringify({ name: "Key" }),
    })).json() as { secret: string };
    const openRequest = () => fetch(`${base}/v1/open`, {
      method: "POST", headers: { authorization: `Bearer ${key.secret}` },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    const first = openRequest();
    const second = openRequest();
    await started;
    const pressure = await (await fetch(`${base}/v1/admin/accounts/tenant-a/pressure`, { headers: admin })).json() as {
      pressure: { active: number; remainingConcurrent: number; globalActive: number; globalMaxConcurrent: number; globalRemainingConcurrent: number };
    };
    assert.deepEqual(pressure.pressure, {
      ...pressure.pressure,
      active: 2,
      remainingConcurrent: 0,
      globalActive: 2,
      globalMaxConcurrent: 2,
      globalRemainingConcurrent: 0,
    });
    assert.equal((await openRequest()).status, 503);
    release();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
  } finally {
    release?.();
    await cleanup(server, directory);
  }
});

test("legacy static API token keeps the existing open contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deeplook-management-"));
  const server = createApiServer(async (url) => page(url), {
    addressResolver: publicResolver,
    authorizationToken: "legacy-secret",
    adminToken,
    accountStore: new AccountStore(directory),
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/open`, { method: "POST", headers: { authorization: "Bearer legacy-secret" }, body: JSON.stringify({ url: "https://example.com" }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { title: string }).title, "Example");
  } finally { await cleanup(server, directory); }
});
