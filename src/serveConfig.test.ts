import assert from "node:assert/strict";
import test from "node:test";

import { readServeConfig } from "./serveConfig.js";

test("public API binding requires an explicit API or administration token", () => {
  assert.throws(() => readServeConfig({ DEEPLOOK_HOST: "0.0.0.0", DEEPLOOK_CLI_PATH: process.execPath }), /DEEPLOOK_API_TOKEN/);
  const apiSecret = "a".repeat(32);
  const adminSecret = "b".repeat(32);
  const api = readServeConfig({ DEEPLOOK_HOST: "0.0.0.0", DEEPLOOK_API_TOKEN: apiSecret, DEEPLOOK_CLI_PATH: process.execPath });
  assert.equal(api.authorizationToken, apiSecret);
  assert.equal(api.adminToken, undefined);
  const managed = readServeConfig({ DEEPLOOK_HOST: "0.0.0.0", DEEPLOOK_ADMIN_TOKEN: adminSecret, DEEPLOOK_CLI_PATH: process.execPath });
  assert.equal(managed.adminToken, adminSecret);
  assert.throws(() => readServeConfig({
    DEEPLOOK_HOST: "0.0.0.0", DEEPLOOK_ADMIN_TOKEN: "too-short", DEEPLOOK_CLI_PATH: process.execPath,
  }), /32-512/);
  assert.throws(() => readServeConfig({
    DEEPLOOK_HOST: "0.0.0.0", DEEPLOOK_API_TOKEN: "s".repeat(32), DEEPLOOK_ADMIN_TOKEN: "s".repeat(32),
    DEEPLOOK_CLI_PATH: process.execPath,
  }), /different secrets/);
});

test("loopback API keeps local operation without a token", () => {
  const config = readServeConfig({ DEEPLOOK_CLI_PATH: process.execPath, DEEPLOOK_DATA_DIR: "/tmp/deeplook-data" });
  assert.deepEqual(config, {
    host: "127.0.0.1", port: 47_231, authorizationToken: undefined, adminToken: undefined,
    dataDir: "/tmp/deeplook-data", maxConcurrent: 2, browserCliPath: process.execPath,
  });
});

test("global browser concurrency is configurable", () => {
  assert.equal(readServeConfig({ DEEPLOOK_CLI_PATH: process.execPath, DEEPLOOK_MAX_CONCURRENT: "8" }).maxConcurrent, 8);
  assert.throws(() => readServeConfig({ DEEPLOOK_CLI_PATH: process.execPath, DEEPLOOK_MAX_CONCURRENT: "0" }), /DEEPLOOK_MAX_CONCURRENT/);
});

test("API startup requires an existing browser CLI", () => {
  assert.throws(() => readServeConfig({}), /DEEPLOOK_CLI_PATH/);
  assert.throws(() => readServeConfig({ DEEPLOOK_CLI_PATH: "relative/cli.js" }), /absolute path/);
  assert.throws(() => readServeConfig({ DEEPLOOK_CLI_PATH: "/does/not/exist/cli.js" }), /existing browser CLI/);
});
