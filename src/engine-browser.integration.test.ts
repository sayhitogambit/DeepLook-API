import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AccountStore } from "./accountStore.js";
import { createBrowserCliOpener } from "./browserCli.js";
import { createApiServer } from "./server.js";

test("HTTP, named key, actual CLI runner and sandboxed Chrome agree on content failures", {
  skip: process.env.DEEPLOOK_TEST_BROWSER !== "1", timeout: 40_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deeplook-real-browser-"));
  const cliPath = join(directory, "fixture-cli.mjs");
  const runner = new URL("../vendor/deeplook/dist/cliRunner.js", import.meta.url).href;
  const engine = new URL("../vendor/deeplook/dist/openPage.js", import.meta.url).href;
  // The subprocess uses the pinned production engine and CLI runner. Only the
  // destination resolver/proxy is injected to serve deterministic local HTML.
  await writeFile(cliPath, `
    import {createServer} from 'node:http';
    import {runCli} from ${JSON.stringify(runner)};
    import {createPageOpener} from ${JSON.stringify(engine)};
    const open = createPageOpener({
      validateUrl: async url => ({url:new URL(url), address:'93.184.216.34',port:80}),
      startProxy: async () => {
        const sockets = new Set();
        const proxy = createServer((req,res) => {
          const path = new URL(req.url).pathname;
          const bodies = {
            '/ok':'<title>Fixture</title><body><script>document.body.append("Rendered page")</script></body>',
            '/challenge':'<title>Robot or human?</title><body>Activate and hold the button to confirm that you are human.</body>',
            '/gate':'<title>Shop</title><body>Click the button below to continue shopping<br>Continue shopping</body>',
            '/empty':'<title>Product</title><body>\\u200b\\u200b</body>',
            '/slow':'<body>Visible<script>Object.defineProperty(document.body,"innerText",{get(){while(true){}}})</script></body>',
          };
          res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(bodies[path]);
        });
        proxy.on('connection', socket => {sockets.add(socket);socket.once('close',()=>sockets.delete(socket))});
        await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
        return {url:'http://127.0.0.1:'+proxy.address().port,close:async()=>{
          for(const socket of sockets)socket.destroy();
          await new Promise((resolve,reject)=>proxy.close(error=>error?reject(error):resolve()));
        }};
      },
    });
    process.exitCode = await runCli(process.argv, open, {stdout:process.stdout,stderr:process.stderr,signals:process});
  `);
  const store = new AccountStore(join(directory, "data"));
  await store.ensureAccount("fixture", { limits: { monthlyRequestQuota: 5, maxConcurrent: 1 } });
  const key = await store.createToken("fixture", "integration");
  const server = createApiServer(createBrowserCliOpener(cliPath), {
    addressResolver: async () => [{ address: "93.184.216.34", family: 4 }],
    accountStore: store, adminToken: "fixture-administrator-token", launchSlackMs: 5_000,
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const endpoint = `http://127.0.0.1:${address.port}/v1/open`;
    assert.equal((await fetch(endpoint, { method: "POST" })).status, 401);
    const cases = [
      { path: "ok", status: 200, error: undefined },
      { path: "challenge", status: 422, error: "challenge" },
      { path: "gate", status: 422, error: "access_wall" },
      { path: "empty", status: 422, error: "empty_content" },
      { path: "slow", status: 504, error: "timeout" },
    ];
    for (const expected of cases) {
      const response = await fetch(endpoint, {
        method: "POST", headers: { authorization: `Bearer ${key.secret}`, "content-type": "application/json" },
        body: JSON.stringify({ url: `http://fixture.example/${expected.path}`, timeoutMs: expected.path === "slow" ? 3_000 : 10_000 }),
      });
      const body = await response.json();
      assert.equal(response.status, expected.status, `${expected.path}: ${JSON.stringify(body)}`);
      assert.equal(body.error, expected.error);
      if (expected.path === "ok") assert.equal(body.text, "Rendered page");
      else assert.equal(body.text, undefined);
    }
    assert.deepEqual(await store.getUsage("fixture"), {
      month: new Date().toISOString().slice(0, 7), requests: 5, succeeded: 1, failed: 4,
    });
    assert.deepEqual((await store.getLogs("fixture")).map((log) => log.status),
      ["timeout", "empty_content", "access_wall", "challenge", "succeeded"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
