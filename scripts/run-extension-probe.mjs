// SPDX-License-Identifier: MPL-2.0
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = resolve(root, ".local/native-extension-probe/result.json");
await rm(result, { force: true });
const child = spawn(resolve(root, "target/debug/shellcanvas.exe"), [], {
  cwd: root,
  windowsHide: true,
  env: { ...process.env, SHELLCANVAS_EXTENSION_PROBE: "1" },
  stdio: "inherit",
});
const timer = setTimeout(() => child.kill(), 60000);
try {
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const report = JSON.parse(await readFile(result, "utf8"));
  console.log(JSON.stringify(report, null, 2));
  // The structured report is authoritative; Windows GUI exit codes are insufficient.
  if (report.success !== true) {
    console.error(
      await readFile(
        resolve(root, ".local/native-extension-probe/progress.jsonl"),
        "utf8",
      ),
    );
    process.exitCode = 1;
  }
} finally {
  clearTimeout(timer);
}
