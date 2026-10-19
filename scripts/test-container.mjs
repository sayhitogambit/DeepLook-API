import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const profile = fileURLToPath(new URL("../security/playwright-seccomp.json", import.meta.url));
const image = `deeplook-api-smoke:${process.pid}`;
const run = (args) => {
  const result = spawnSync("docker", args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

try {
  process.exitCode = run(["build", "-t", image, "."]);
  if (process.exitCode === 0) {
    process.exitCode = run([
      "run", "--rm", "--network", "none", "--cap-drop", "ALL", "--cap-add", "SYS_CHROOT",
      "--security-opt", "no-new-privileges=true", "--security-opt", `seccomp=${profile}`,
      "--pids-limit", "256", "--memory", "2g", "--cpus", "2",
      "-e", "DEEPLOOK_TEST_BROWSER=1", "--entrypoint", "node", image,
      "--test", "/app/dist/engine-browser.integration.test.js",
    ]);
  }
} finally {
  // This tag belongs only to this smoke run; shared image layers are retained.
  spawnSync("docker", ["image", "rm", image], { cwd: root, stdio: "ignore" });
}
