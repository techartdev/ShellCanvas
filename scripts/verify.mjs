// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runChecks } from "./verification.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Usage: npm run verify -- [--native]\n--native also builds the current platform's debug desktop executable.",
  );
} else if (args.some((arg) => arg !== "--native") || args.length > 1) {
  console.error("Unknown arguments. Use npm run verify -- --help.");
  process.exitCode = 2;
} else {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !existsSync(npmCli)) {
    throw new Error("Run this entry point through npm run verify.");
  }
  const command = (file, commandArgs, options = {}) =>
    spawnSync(file, commandArgs, {
      cwd: root,
      shell: false,
      windowsHide: true,
      ...options,
    });
  const capture = (file, commandArgs, trim = true) => {
    const result = command(file, commandArgs, { encoding: "utf8" });
    if (result.error || result.status !== 0 || result.signal)
      throw new Error(
        `${file} ${commandArgs.join(" ")}: ${result.error || result.stderr || result.signal || result.status}`,
      );
    return trim ? result.stdout.trim() : result.stdout;
  };
  // Include uncommitted and untracked source bytes, not just the HEAD commit.
  // Ignored dependencies, build output and .local reports are intentionally excluded.
  const sourceSnapshot = () => {
    const head = capture("git", ["rev-parse", "HEAD"]);
    const status = capture("git", [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    const digest = createHash("sha256")
      .update(head)
      .update("\0")
      .update(status);
    const diff = command("git", ["diff", "--binary", "HEAD"], {
      maxBuffer: 64 * 1024 * 1024,
    });
    if (diff.error || diff.status !== 0)
      throw new Error("Cannot fingerprint the working-tree diff");
    digest.update(diff.stdout);
    const untracked = capture(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      false,
    );
    for (const path of untracked.split("\0").filter(Boolean).sort()) {
      const absolute = resolve(root, path);
      const contents = lstatSync(absolute).isSymbolicLink()
        ? readlinkSync(absolute)
        : readFileSync(absolute);
      digest.update("\0").update(path).update("\0").update(contents);
    }
    return { head, dirty: status !== "", fingerprint: digest.digest("hex") };
  };
  const directory = resolve(root, ".local/verification");
  mkdirSync(directory, { recursive: true });
  const reportPath = resolve(
    directory,
    `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`,
  );
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    nativeBuildRequested: args.includes("--native"),
    status: "running",
    source: null,
    tools: { node: process.version },
    checks: [],
    scope:
      "Local automated checks only; no remote probes, UI walkthrough, installer, signing or cross-platform claim.",
  };
  const persist = () =>
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  try {
    report.source = sourceSnapshot();
    report.tools.npm = capture(process.execPath, [npmCli, "--version"]);
    report.tools.cargo = capture("cargo", ["--version"]);
    report.tools.rustc = capture("rustc", ["--version"]);
    const checks = [
      {
        name: "Verification runner tests",
        file: process.execPath,
        args: ["--test", "scripts/verification.check.mjs"],
      },
      {
        name: "Rust formatting",
        file: "cargo",
        args: ["fmt", "--all", "--", "--check"],
      },
      {
        name: "Updater manifest tests",
        file: process.execPath,
        args: ["--test", "scripts/updater-manifest.check.mjs"],
      },
      {
        name: "Public app SDK build and package checks",
        file: process.execPath,
        args: [npmCli, "run", "test:sdk"],
      },
      {
        name: "Frontend tests",
        file: process.execPath,
        args: [npmCli, "test"],
      },
      {
        name: "Frontend production build",
        file: process.execPath,
        args: [npmCli, "run", "build"],
      },
      {
        name: "Rust workspace tests",
        file: "cargo",
        args: ["test", "--workspace", "--locked"],
      },
      {
        name: "Rust all-target lint",
        file: "cargo",
        args: [
          "clippy",
          "--workspace",
          "--all-targets",
          "--locked",
          "--",
          "-D",
          "warnings",
        ],
      },
    ];
    if (report.nativeBuildRequested)
      checks.push({
        name: "Native debug executable",
        file: process.execPath,
        args: [npmCli, "run", "tauri", "--", "build", "--debug", "--no-bundle"],
      });
    const passed = runChecks(
      checks,
      (check) => {
        console.log(`\nChecking: ${check.name}`);
        return command(check.file, check.args, { stdio: "inherit" });
      },
      (results) => {
        report.checks = results;
        persist();
      },
    );
    report.sourceAfter = sourceSnapshot();
    report.sourceChanged =
      report.source.fingerprint !== report.sourceAfter.fingerprint;
    report.status = passed && !report.sourceChanged ? "passed" : "failed";
    if (report.sourceChanged)
      report.error =
        "Source changed during verification; run again against a stable checkout.";
  } catch (error) {
    report.status = "failed";
    report.error = String(error);
  } finally {
    report.finishedAt = new Date().toISOString();
    persist();
    console.log(`\nVerification ${report.status}. Report: ${reportPath}`);
    if (report.error) console.error(report.error);
    process.exitCode = report.status === "passed" ? 0 : 1;
  }
}
