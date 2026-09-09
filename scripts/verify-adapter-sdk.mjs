// SPDX-License-Identifier: MPL-2.0
// Build only exported SDK sources outside the checkout, then use the real host.
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAdapterSchemas } from "./check-adapter-schemas.mjs";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "shellcanvas adapter sdk "));
const reportDir = join(repo, ".local/adapter-sdk-verification");
mkdirSync(reportDir, { recursive: true });
const report = { success: false, root, checks: {}, error: undefined };
function run(cwd, command, args, environment = {}) {
  const result = spawnSync(command, args, {
    cwd,
    windowsHide: true,
    shell: false,
    stdio: "inherit",
    env: { ...process.env, ...environment },
  });
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${result.error ?? result.status}`);
}
try {
  const exported = join(root, "exported");
  run(repo, "cargo", [
    "package",
    "-p",
    "shellcanvas-adapter-sdk",
    "--allow-dirty",
    "--offline",
    "--no-verify",
    "--target-dir",
    exported,
  ]);
  const archive = join(exported, "package/shellcanvas-adapter-sdk-0.1.0.crate");
  report.archive = archive;
  run(root, "tar", ["-xzf", archive, "-C", root]);
  const source = join(root, "shellcanvas-adapter-sdk-0.1.0");
  const manifest = join(source, "Cargo.toml");
  if (
    readFileSync(manifest, "utf8")
      .split(/(?=^\[)/m)
      .filter((section) => section.split("\n")[0].includes("dependencies"))
      .some((section) => /\bpath\s*=/.test(section))
  )
    throw new Error("Exported SDK has a path dependency");
  run(source, "cargo", [
    "build",
    "--bins",
    "--example",
    "echo",
    "--locked",
    "--offline",
    "--target-dir",
    join(root, "build"),
  ]);
  report.checks.independentBuild = true;
  const executable = join(
    root,
    `build/debug/examples/echo${process.platform === "win32" ? ".exe" : ""}`,
  );
  if (!existsSync(executable))
    throw new Error("Missing standalone example executable");
  report.executable = executable;
  run(
    repo,
    "cargo",
    ["test", "-p", "shellcanvas-adapter-runtime", "--test", "sdk", "--locked"],
    { SHELLCANVAS_SDK_ADAPTER_EXE: executable },
  );
  report.checks.productionHostInterop = true;
  const cli = join(
    root,
    `build/debug/shellcanvas-adapter${process.platform === "win32" ? ".exe" : ""}`,
  );
  const project = join(root, "generated device");
  run(root, cli, [
    "init",
    project,
    "--id",
    "example.device",
    "--name",
    "SDK practice device",
    "--sdk-source",
    source,
  ]);
  const packaged = join(root, "generated package");
  run(root, cli, ["build", project, packaged, "--debug"], {
    CARGO_NET_OFFLINE: "true",
  });
  run(root, cli, ["validate", join(packaged, "adapter.json")]);
  report.package = join(packaged, "adapter.json");
  report.checks.generatedProjectPackaged = true;
  checkAdapterSchemas(source, project, packaged);
  report.checks.schemas = true;
  const generatedExecutable = join(
    packaged,
    JSON.parse(readFileSync(report.package, "utf8")).entrypoint,
  );
  run(
    repo,
    "cargo",
    ["test", "-p", "shellcanvas-adapter-runtime", "--test", "sdk", "--locked"],
    { SHELLCANVAS_SDK_ADAPTER_EXE: generatedExecutable },
  );
  report.checks.generatedHostInterop = true;
  report.success = true;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  writeFileSync(
    join(reportDir, "latest.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
