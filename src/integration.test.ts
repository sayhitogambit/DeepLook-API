import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBrowserCliOpener } from "./browserCli.js";
import { createApiServer } from "./server.js";

test("HTTP API delegates to the separate browser CLI and keeps the public contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deeplook-api-integration-"));
  const cliPath = join(directory, "cli.mjs");
  await writeFile(cliPath, `
    const url = process.argv[3];
    if (url.endsWith('/blocked')) {
      process.stdout.write(JSON.stringify({version:1,ok:false,error:'challenge',
        message:'The site returned a bot check instead of the page.',finalUrl:url,
        title:'Just a moment...',marker:'just a moment'}));
      process.exitCode = 1;
    } else if (url.endsWith('/slow')) {
      process.stdout.write(JSON.stringify({version:1,ok:false,error:'timeout',message:'Navigation timed out.'}));
      process.exitCode = 1;
    } else {
    process.stdout.write(JSON.stringify({version:1,ok:true,page:{requestedUrl:url,
      finalUrl:url,title:'Example',text:'A sourced page',truncated:false,httpStatus:200,
      observed:{webdriver:false,userAgent:'Chrome',brands:[],languages:['en-US'],
        timezone:'UTC',viewport:{width:1366,height:768}}}}));
    }
  `);
  const server = createApiServer(createBrowserCliOpener(cliPath), {
    addressResolver: async () => [{ address: "93.184.216.34", family: 4 }],
    authorizationToken: "fixture-token",
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const denied = await fetch(`${base}/v1/open`, { method: "POST" });
    assert.equal(denied.status, 401);
    const response = await fetch(`${base}/v1/open`, {
      method: "POST",
      headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/" }),
    });
    assert.equal(response.status, 200);
    const page = await response.json() as { title: string; text: string; finalUrl: string };
    assert.deepEqual({ title: page.title, text: page.text, finalUrl: page.finalUrl }, {
      title: "Example", text: "A sourced page", finalUrl: "https://example.com/",
    });
    const blocked = await fetch(`${base}/v1/open`, {
      method: "POST",
      headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/blocked" }),
    });
    assert.equal(blocked.status, 422);
    const blockedBody = await blocked.json() as { error: string; text?: string; marker: string };
    assert.equal(blockedBody.error, "challenge");
    assert.equal(blockedBody.marker, "just a moment");
    assert.equal(blockedBody.text, undefined);
    const slow = await fetch(`${base}/v1/open`, {
      method: "POST",
      headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/slow" }),
    });
    assert.equal(slow.status, 504);
    assert.equal((await slow.json() as { error: string }).error, "timeout");
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
