import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir, open, readdir, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { browserEnvironment } from "./runtimeEnvironment.js";
import { AccountStore } from "./accountStore.js";

async function within<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Process operation timed out")), ms); })]); }
  finally { clearTimeout(timer); }
}

async function fixture(resistant = false) {
  const directory = await mkdtemp(join(tmpdir(), "deeplook api shutdown "));
  const cli = join(directory, "browser.cjs");
  const pidsFile = join(directory, "pids.json");
  const cleanupFile = join(directory, "cleaned");
  const dataDir = join(directory, "data");
  await writeFile(cli, `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const owned = ${resistant ? "undefined" : 'spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })'};
const keepalive = setInterval(() => {}, 1000);
process.on("SIGTERM", () => { ${resistant ? "" : `setTimeout(() => {
  owned.once("close", () => {
    writeFileSync(${JSON.stringify(cleanupFile)}, "done");
    clearInterval(keepalive); process.exitCode = 1;
  });
  owned.kill("SIGKILL");
}, 150);`} });
writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify([process.pid, owned?.pid].filter(Boolean)));
`);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const secret = "fixture-only-shutdown-api-token-32";
  const adminSecret = "fixture-only-shutdown-admin-token-32";
  const api = spawn(process.execPath, [fileURLToPath(new URL("./serve.js", import.meta.url))], {
    env: { ...browserEnvironment(), DEEPLOOK_HOST: "127.0.0.1", DEEPLOOK_PORT: String(port),
      DEEPLOOK_CLI_PATH: cli, DEEPLOOK_API_TOKEN: secret, DEEPLOOK_ADMIN_TOKEN: adminSecret,
      DEEPLOOK_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  api.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.includes("listening on")) ready(); });
  api.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    api.once("error", reject); api.once("close", (code, signal) => resolve({ code, signal }));
  });
  const stop = async () => {
    api.kill("SIGKILL");
    await exited;
    try {
      const pids: number[] = JSON.parse(await readFile(pidsFile, "utf8"));
      for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await rm(directory, { recursive: true, force: true });
  };
  try { await within(started); } catch (error) { await stop(); throw error; }
  return { api, exited, port, pidsFile, cleanupFile, dataDir, stop,
    output: () => stdout + stderr, secret, adminSecret,
    issueKey: async () => {
      const base = `http://127.0.0.1:${port}/v1/admin/accounts/shutdown-account`;
      const headers = { authorization: `Bearer ${adminSecret}`, "content-type": "application/json" };
      const account = await fetch(base, { method: "PUT", headers, body: "{}" });
      assert.equal(account.status, 200); await account.json();
      const key = await fetch(`${base}/tokens`, { method: "POST", headers, body: JSON.stringify({ name: "shutdown-key" }) });
      assert.equal(key.status, 201);
      return (await key.json() as { secret: string }).secret;
    },
    open: (token = secret) => fetch(`http://127.0.0.1:${port}/v1/open`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ url: "https://1.1.1.1/", timeoutMs: 120_000 }) }).catch(() => undefined),
  };
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`API ${signal} awaits active CLI and owned subprocess cleanup`, { skip: process.platform === "win32" }, async () => {
    const service = await fixture();
    const pending = service.open();
    try {
      let pids: number[] | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { pids = JSON.parse(await readFile(service.pidsFile, "utf8")); break; } catch { await delay(10); }
      }
      assert.ok(pids, "the API must have started a CLI operation");
      service.api.kill(signal);
      assert.deepEqual(await within(service.exited), { code: 0, signal: null }, "API should finish orderly shutdown");
      assert.equal(await readFile(service.cleanupFile, "utf8"), "done");
      for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      assert.equal(service.output().includes(service.secret), false);
    } finally { await service.stop(); await pending; }
  });
}

test("API shutdown waits for escalation when the CLI ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const service = await fixture(true);
  const pending = service.open();
  try {
    let pid: number | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { [pid] = JSON.parse(await readFile(service.pidsFile, "utf8")); break; } catch { await delay(10); }
    }
    assert.ok(pid);
    service.api.kill("SIGTERM");
    assert.deepEqual(await within(service.exited), { code: 0, signal: null });
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally { await service.stop(); await pending; }
});

test("API shutdown persists a managed request as canceled before exiting", { skip: process.platform === "win32" }, async () => {
  const service = await fixture();
  const key = await service.issueKey();
  const pending = service.open(key);
  try {
    let started = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await readFile(service.pidsFile, "utf8"); started = true; break; } catch { await delay(10); }
    }
    assert.equal(started, true);
    service.api.kill("SIGTERM");
    assert.deepEqual(await within(service.exited), { code: 0, signal: null });
    const store = new AccountStore(service.dataDir);
    const logs = await store.getLogs("shutdown-account");
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, "canceled");
    assert.equal((await store.getUsage("shutdown-account")).requests, 1);
    assert.equal(service.output().includes(key), false);
  } finally { await service.stop(); await pending; }
});

test("API shutdown bounds store I/O remaining after the HTTP client disconnects", { skip: process.platform !== "linux" }, async () => {
  const service = await fixture();
  await mkdir(service.dataDir);
  const fifo = join(service.dataDir, "accounts.json");
  await promisify(execFile)("mkfifo", [fifo]);
  // Keep a real readFile blocked inside the service's libuv worker, independent
  // of HTTP connections. This models store/DNS work that outlives a disconnect.
  const writer = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
  const controller = new AbortController();
  const pending = fetch(`http://127.0.0.1:${service.port}/v1/admin/accounts/blocked`, {
    headers: { authorization: `Bearer ${service.adminSecret}` }, signal: controller.signal,
  }).catch(() => undefined);
  try {
    let reading = false;
    for (let attempt = 0; attempt < 100 && !reading; attempt++) {
      const descriptors = await readdir(`/proc/${service.api.pid}/fd`);
      for (const descriptor of descriptors) {
        try { if (await readlink(`/proc/${service.api.pid}/fd/${descriptor}`) === fifo) reading = true; } catch {}
      }
      if (!reading) await delay(10);
    }
    assert.equal(reading, true, "the service must be awaiting real store I/O before disconnect");
    controller.abort();
    await pending; await delay(25);
    service.api.kill("SIGTERM");
    assert.deepEqual(await within(service.exited, 11_000), { code: null, signal: "SIGKILL" });
    assert.match(service.output(), /shutdown.*timed out/i);
  } finally {
    controller.abort(); await writer.close(); await service.stop(); await pending;
  }
});

test("API shutdown bounds incomplete HTTP request draining", { skip: process.platform === "win32" }, async () => {
  const service = await fixture();
  const socket = connect({ host: "127.0.0.1", port: service.port });
  socket.on("error", () => {});
  try {
    await within(new Promise<void>((resolve) => socket.once("connect", resolve)));
    socket.write(`POST /v1/open HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${service.secret}\r\nContent-Length: 100\r\n\r\n{`);
    await delay(100);
    service.api.kill("SIGTERM");
    assert.deepEqual(await within(service.exited, 11_000), { code: null, signal: "SIGKILL" });
    assert.match(service.output(), /shutdown.*timed out/i);
    assert.equal(service.output().includes(service.secret), false);
  } finally { socket.destroy(); await service.stop(); }
});
