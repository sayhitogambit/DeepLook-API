import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createBrowserCliOpener, BrowserCliError } from "./browserCli.js";

async function fixture(code: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "deeplook-cli-test-"));
  const path = join(directory, "cli.mjs");
  await writeFile(path, code);
  return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("adapter returns versioned browser output", async () => {
  const { path, cleanup } = await fixture(`
    if (process.argv.slice(2).join(' ') !== 'open https://example.com/ --machine --timeout-ms 1234') process.exit(8);
    process.stdout.write(JSON.stringify({version:1,ok:true,page:{
      requestedUrl:'https://example.com/',finalUrl:'https://example.com/',title:'Example',text:'body',truncated:false,
      observed:{webdriver:false,userAgent:'Chrome',brands:[],languages:['en-US'],timezone:'UTC',viewport:{width:1,height:1}}
    }}));
  `);
  try {
    const page = await createBrowserCliOpener(path)("https://example.com/", 1234, new AbortController().signal);
    assert.equal(page.title, "Example");
  } finally { await cleanup(); }
});

test("adapter preserves typed browser errors without page text", async () => {
  const { path, cleanup } = await fixture(`
    process.stdout.write(JSON.stringify({version:1,ok:false,error:'challenge',message:'Bot check',
      finalUrl:'https://example.com/',title:'Just a moment...',marker:'just a moment'}));
    process.exitCode = 1;
  `);
  try {
    await assert.rejects(createBrowserCliOpener(path)("https://example.com/", 1234, new AbortController().signal),
      (cause) => cause instanceof BrowserCliError && cause.code === "challenge" && cause.marker === "just a moment");
  } finally { await cleanup(); }
});

test("adapter rejects malformed output", async () => {
  const { path, cleanup } = await fixture(`process.stdout.write('not json')`);
  try {
    await assert.rejects(createBrowserCliOpener(path)("https://example.com/", 1234, new AbortController().signal),
      /invalid browser response/i);
  } finally { await cleanup(); }
});

test("adapter kills canceled browser process and waits for exit", async () => {
  const { path, cleanup } = await fixture(`setInterval(() => {}, 1000)`);
  const controller = new AbortController();
  try {
    const pending = createBrowserCliOpener(path)("https://example.com/", 1234, controller.signal);
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, /canceled/i);
  } finally { await cleanup(); }
});
