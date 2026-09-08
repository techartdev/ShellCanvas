// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from "node:child_process";
import { lstat, realpath, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { packAdapter } from "./pack-adapter.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const build = spawnSync(
  "cargo",
  [
    "build",
    "-p",
    "shellcanvas-adapter-runtime",
    "--bin",
    "fixture-adapter",
    "--locked",
  ],
  { cwd: root, stdio: "inherit", shell: false, windowsHide: true },
);
if (build.status !== 0) throw new Error("Fixture adapter build failed");
const packages = resolve(root, ".local/native-adapter-probe/packages");
try {
  const stat = await lstat(packages);
  const actual = await realpath(packages);
  const workspace = await realpath(root);
  if (
    stat.isSymbolicLink() ||
    !actual.startsWith(workspace + sep) ||
    actual !== packages
  )
    throw new Error(
      "Refusing to replace an unexpected adapter fixture directory",
    );
  await rm(actual, { recursive: true });
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
for (const version of [1, 2])
  await packAdapter(
    resolve(root, "examples/fixture-adapter/adapter.json"),
    resolve(
      root,
      `target/debug/fixture-adapter${process.platform === "win32" ? ".exe" : ""}`,
    ),
    resolve(packages, `v${version}`),
    `${version}.0.0`,
  );
await import("./build-extension-probe.mjs");
