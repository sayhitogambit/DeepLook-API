#!/usr/bin/env node

import { createBrowserCliOpener } from "./browserCli.js";
import { AccountStore } from "./accountStore.js";
import { readServeConfig } from "./serveConfig.js";
import { createApiServer } from "./server.js";
import type { PageOpener } from "./server.js";

let config;
try {
  config = readServeConfig(process.env);
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
}
const shutdown = new AbortController();
const browserOpen = createBrowserCliOpener(config.browserCliPath);
const pending = new Set<Promise<unknown>>();
const open: PageOpener = (url, timeoutMs, signal) => {
  const combined = AbortSignal.any([signal, shutdown.signal]);
  combined.throwIfAborted();
  const operation = browserOpen(url, timeoutMs, combined);
  pending.add(operation);
  void operation.then(() => pending.delete(operation), () => pending.delete(operation));
  return operation;
};
const server = createApiServer(open, {
  shutdownSignal: shutdown.signal,
  authorizationToken: config.authorizationToken,
  adminToken: config.adminToken,
  accountStore: config.adminToken === undefined ? undefined : new AccountStore(config.dataDir),
  maxConcurrent: config.maxConcurrent,
});

let stopping = false;
server.on("request", (_request, response) => {
  // A request active when close() starts can become an idle keep-alive later.
  response.once("finish", () => { if (stopping) server.closeIdleConnections(); });
});
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  // Keep this below the container's stop grace period. The CLI adapter owns
  // browser termination and escalates to SIGKILL after its two-second grace.
  const timer = setTimeout(() => {
    process.stderr.write("DeepLook API shutdown timed out.\n");
    server.closeAllConnections();
    // process.exit can wait for blocked native worker I/O. At the hard deadline,
    // use the OS termination path; browser CLI cleanup already had its grace.
    process.kill(process.pid, "SIGKILL");
  }, 8_000);
  timer.unref();
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  shutdown.abort(new Error("The API is shutting down."));
  await Promise.allSettled([...pending]);
  await closed;
  // Disconnected handlers may still await DNS or store I/O after close().
  // This unref'ed watchdog must remain armed until the process exits naturally.
  process.exitCode = 0;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { void stop(); });
}

server.listen(config.port, config.host, () => {
  process.stdout.write(`DeepLook API listening on http://${config.host}:${config.port}\n`);
});
