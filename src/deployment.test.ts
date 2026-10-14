import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("container builds the private relative browser checkout and runs nonroot with persistent state", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /COPY vendor\/deeplook\/package\.json/);
  assert.match(dockerfile, /DEEPLOOK_CLI_PATH=\/app\/vendor\/deeplook\/dist\/cli\.js/);
  assert.match(dockerfile, /DEEPLOOK_DATA_DIR=\/app\/data/);
  assert.match(dockerfile, /VOLUME \["\/app\/data"\]/);
  assert.match(dockerfile, /USER deeplook/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.doesNotMatch(dockerfile, /DEEPLOOK_(?:API|ADMIN)_TOKEN=/);
  assert.doesNotMatch(dockerfile, /ARG .*TOKEN/i);
});
