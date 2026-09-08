// SPDX-License-Identifier: MPL-2.0
// Packs the public SDK, then consumes only that tarball in fresh projects outside the repo.
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.env.npm_execpath;
if (!npm || !existsSync(npm)) throw new Error("Use npm run verify:sdk.");
const output = join(repo, ".local/sdk-verification");
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(tmpdir(), "shellcanvas standalone sdk "));
const report = { success: false, root, checks: {}, error: undefined };
const run = (cwd, args) => {
  const result = spawnSync(process.execPath, args, {
    cwd,
    windowsHide: true,
    stdio: "inherit",
  });
  if (result.error || result.status !== 0)
    throw new Error(`${args.join(" ")}: ${result.error ?? result.status}`);
};
try {
  run(repo, [
    npm,
    "pack",
    "--workspace",
    "@shellcanvas/app-sdk",
    "--pack-destination",
    root,
  ]);
  const archive = join(root, "shellcanvas-app-sdk-0.1.0.tgz");
  const tooling = join(root, "tools");
  mkdirSync(tooling);
  writeFileSync(
    join(tooling, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: {
        "@shellcanvas/app-sdk": `file:${archive.replaceAll("\\", "/")}`,
      },
    }),
  );
  run(tooling, [npm, "install", "--no-audit", "--no-fund"]);
  const cli = join(
    tooling,
    "node_modules/@shellcanvas/app-sdk/bin/shellcanvas-app.mjs",
  );
  const project = join(root, "starter");
  run(root, [
    cli,
    "init",
    project,
    "--id",
    "org.example.sdk-starter",
    "--title",
    "Workspace Notes",
    "--sdk",
    archive,
  ]);
  run(project, [npm, "install", "--no-audit", "--no-fund"]);
  run(project, [npm, "run", "build"]);
  run(project, [cli, "validate", join(project, "dist/app.shellcanvas.json")]);
  const artifact = JSON.parse(
    readFileSync(join(project, "dist/app.shellcanvas.json"), "utf8"),
  );
  if (artifact.script.includes(repo) || artifact.script.includes("../../src/"))
    throw new Error("The standalone artifact refers to desktop source files.");
  copyFileSync(
    join(project, "dist/app.shellcanvas.json"),
    join(output, "starter.shellcanvas.json"),
  );
  copyFileSync(archive, join(output, "shellcanvas-app-sdk-0.1.0.tgz"));
  report.checks.packedSdk = true;
  report.checks.generatedStarter = true;
  report.checks.independentTypecheckAndBuild = true;
  report.checks.packageAccepted = true;

  // The same generated app plus test-only DOM controls for the opaque native frame.
  copyFileSync(join(project, "main.ts"), join(project, "app.ts"));
  writeFileSync(
    join(project, "main.ts"),
    readFileSync(join(repo, "tests/fixtures/sdk-starter-client.ts"), "utf8"),
  );
  run(project, [npm, "run", "build"]);
  copyFileSync(
    join(project, "dist/app.shellcanvas.json"),
    join(output, "starter-probe.shellcanvas.json"),
  );

  // Existing lifecycle/clipboard walkthrough also consumes this installed tarball.
  writeFileSync(
    join(project, "app.ts"),
    readFileSync(join(repo, "examples/dialog-app/main.ts"), "utf8"),
  );
  const probe = readFileSync(
    join(repo, "tests/fixtures/desktop-probe-client.ts"),
    "utf8",
  )
    .replace('"../../examples/dialog-app/main"', '"./app"')
    .replace(
      '"../../src/extensions/environment-api"',
      '"@shellcanvas/app-sdk"',
    );
  writeFileSync(join(project, "main.ts"), probe);
  copyFileSync(
    join(repo, "examples/dialog-app/style.css"),
    join(project, "style.css"),
  );
  run(project, [npm, "run", "build"]);
  copyFileSync(
    join(project, "dist/app.shellcanvas.json"),
    join(output, "desktop-probe.shellcanvas.json"),
  );
  report.checks.independentLifecycleFixture = true;
  report.success = true;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
}
writeFileSync(
  join(output, "result.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
