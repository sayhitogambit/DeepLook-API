import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountStore } from "./accountStore.js";

test("account storage is durable, atomic, private, and never stores browser secrets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deeplook-accounts-"));
  try {
    const store = new AccountStore(directory, { clock: () => new Date("2026-10-14T12:00:00.000Z") });
    const account = await store.ensureAccount("customer-42", {
      name: "Example customer",
      limits: { maxConcurrent: 3, monthlyRequestQuota: 100 },
    });
    assert.equal(account.externalId, "customer-42");
    assert.deepEqual(account.limits, { maxConcurrent: 3, monthlyRequestQuota: 100 });

    const created = await store.createToken("customer-42", "Production");
    assert.match(created.secret, /^dlk_[A-Za-z0-9_-]{43}$/);
    assert.equal((await store.authenticateToken(created.secret))?.externalId, "customer-42");

    const storagePath = join(directory, "accounts.json");
    const persisted = await readFile(storagePath, "utf8");
    assert.equal(persisted.includes(created.secret), false);
    assert.match(persisted, /"hash":"[a-f0-9]{64}"/);
    assert.equal((await stat(storagePath)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);

    const restarted = new AccountStore(directory);
    assert.equal((await restarted.authenticateToken(created.secret))?.tokenId, created.token.id);
    assert.equal((await restarted.listTokens("customer-42"))[0]?.name, "Production");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rotation invalidates the old browser key and revocation invalidates the new key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deeplook-accounts-"));
  try {
    const store = new AccountStore(directory);
    await store.ensureAccount("tenant-a", {});
    const original = await store.createToken("tenant-a", "Automation");
    const rotated = await store.rotateToken("tenant-a", original.token.id);
    assert.equal(await store.authenticateToken(original.secret), undefined);
    assert.equal((await store.authenticateToken(rotated.secret))?.tokenId, original.token.id);
    await store.revokeToken("tenant-a", original.token.id);
    assert.equal(await store.authenticateToken(rotated.secret), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed persistence write does not activate an undelivered browser key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deeplook-accounts-"));
  try {
    const store = new AccountStore(directory);
    await store.ensureAccount("tenant-a", {});
    const internal = store as unknown as { persist: () => Promise<void> };
    internal.persist = async () => { throw new Error("fixture write failure"); };

    await assert.rejects(store.createToken("tenant-a", "Production"), /fixture write failure/);
    assert.deepEqual(await store.listTokens("tenant-a"), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("logs retain only hostname and are capped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deeplook-accounts-"));
  try {
    const store = new AccountStore(directory, { maxLogsPerAccount: 2 });
    await store.ensureAccount("tenant-a", {});
    for (let index = 0; index < 3; index += 1) {
      await store.recordRequest("tenant-a", {
        requestId: `request-${index}`,
        tokenId: "token-1",
        hostname: "example.com",
        startedAt: "2026-10-14T12:00:00.000Z",
        completedAt: "2026-10-14T12:00:01.000Z",
        durationMs: 1_000,
        status: "succeeded",
      });
    }
    const logs = await store.getLogs("tenant-a");
    assert.deepEqual(logs.map((entry) => entry.requestId), ["request-2", "request-1"]);
    assert.equal(JSON.stringify(logs).includes("https://"), false);
    assert.equal((await store.getUsage("tenant-a")).requests, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
