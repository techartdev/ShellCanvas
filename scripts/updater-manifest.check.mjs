// SPDX-License-Identifier: MPL-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformKey, manifest } from "./updater-manifest.mjs";
test("package types and architectures remain distinct", () => {
  for (const [os, arch, file, expected] of [
    ["windows", "x86_64", "App.msi", "windows-x86_64-msi"],
    ["windows", "x86_64", "App-setup.exe", "windows-x86_64-nsis"],
    ["darwin", "aarch64", "App.app.tar.gz", "darwin-aarch64-app"],
    ["linux", "x86_64", "App.AppImage", "linux-x86_64-appimage"],
    ["linux", "x86_64", "App.deb", "linux-x86_64-deb"],
    ["linux", "aarch64", "App.rpm", "linux-aarch64-rpm"],
  ])
    assert.equal(platformKey(os, arch, file), expected);
  assert.throws(() => platformKey("linux", "x86_64", "App.msi"));
});
test("manifest refuses missing signatures and mixed releases; preserves other platforms", async () => {
  const directory = await mkdtemp(join(tmpdir(), "shellcanvas-manifest-"));
  try {
    const options = {
      version: "0.2.0",
      os: "windows",
      arch: "x86_64",
      directory,
    };
    await assert.rejects(manifest(options), /No signed/);
    await writeFile(join(directory, "ShellCanvas-setup.exe.sig"), "dGVzdA==");
    await assert.rejects(manifest(options), /ENOENT/);
    await writeFile(join(directory, "ShellCanvas-setup.exe"), "fixture");
    await assert.rejects(
      manifest({ ...options, previous: { version: "0.1.0" } }),
      /different releases/,
    );
    const previous = {
      version: "0.2.0",
      platforms: { "darwin-aarch64-app": { signature: "old", url: "old" } },
    };
    const result = await manifest({ ...options, previous });
    assert.deepEqual(
      result.platforms["darwin-aarch64-app"],
      previous.platforms["darwin-aarch64-app"],
    );
    assert.match(
      result.platforms["windows-x86_64-nsis"].url,
      /\/v0\.2\.0\/ShellCanvas-setup\.exe$/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
