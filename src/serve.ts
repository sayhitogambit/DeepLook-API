#!/usr/bin/env node

import { createBrowserCliOpener } from "./browserCli.js";
import { readServeConfig } from "./serveConfig.js";
import { createApiServer } from "./server.js";

let config;
try {
  config = readServeConfig(process.env);
} catch (cause) {
  process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
}
const server = createApiServer(createBrowserCliOpener(config.browserCliPath), {
  authorizationToken: config.authorizationToken,
});

server.listen(config.port, config.host, () => {
  process.stdout.write(`DeepLook API listening on http://${config.host}:${config.port}\n`);
});
