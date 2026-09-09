// SPDX-License-Identifier: MPL-2.0
// Repository compatibility wrapper; validation and packing belong to the SDK.
import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export async function packAdapter(manifest, executable, output, version) {
  if (!executable) throw new Error("Choose an adapter executable");
  output = resolve(output);
  await mkdir(dirname(output), { recursive: true });
  const args = [
    "run",
    "-p",
    "shellcanvas-adapter-sdk",
    "--bin",
    "shellcanvas-adapter",
    "--locked",
    "--",
    "pack",
    resolve(manifest),
    resolve(executable),
    output,
  ];
  if (version !== undefined) args.push("--version", version);
  const result = spawnSync("cargo", args, {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    windowsHide: true,
    shell: false,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Adapter packaging failed: ${result.error ?? result.status}`,
    );
  return resolve(output, "adapter.json");
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [manifest, executable, output] = process.argv.slice(2);
  if (!manifest || !executable || !output)
    throw new Error(
      "Usage: node scripts/pack-adapter.mjs manifest executable output-directory",
    );
  console.log(await packAdapter(manifest, executable, output));
}
