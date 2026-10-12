import assert from "node:assert/strict";
import test from "node:test";

import { readServeConfig } from "./serveConfig.js";

test("public API binding requires an explicit token", () => {
  assert.throws(() => readServeConfig({ DEEPLOOK_HOST: "0.0.0.0", DEEPLOOK_CLI_PATH: process.execPath }), /DEEPLOOK_API_TOKEN/);
  assert.deepEqual(readServeConfig({ DEEPLOOK_HOST: "0.0.0.0", DEEPLOOK_API_TOKEN: "fixture-secret", DEEPLOOK_CLI_PATH: process.execPath }), {
    host: "0.0.0.0", port: 47_231, authorizationToken: "fixture-secret", browserCliPath: process.execPath,
  });
});

test("loopback API keeps local operation without a token", () => {
  assert.deepEqual(readServeConfig({ DEEPLOOK_CLI_PATH: process.execPath }), {
    host: "127.0.0.1", port: 47_231, authorizationToken: undefined, browserCliPath: process.execPath,
  });
});

test("API startup requires an existing browser CLI", () => {
  assert.throws(() => readServeConfig({}), /DEEPLOOK_CLI_PATH/);
  assert.throws(() => readServeConfig({ DEEPLOOK_CLI_PATH: "relative/cli.js" }), /absolute path/);
  assert.throws(() => readServeConfig({ DEEPLOOK_CLI_PATH: "/does/not/exist/cli.js" }), /existing browser CLI/);
});
