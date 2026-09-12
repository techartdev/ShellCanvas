// SPDX-License-Identifier: MPL-2.0
// Invoked by the serialized, manually requested platform release job.
import { execFileSync } from "node:child_process";
import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  copyFile,
} from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { manifest } from "./updater-manifest.mjs";

const [tag, platform] = process.argv.slice(2);
if (
  !/^v\d+\.\d+\.\d+$/.test(tag) ||
  !["linux-x86_64", "darwin-x86_64", "darwin-aarch64"].includes(platform)
)
  throw new Error("Invalid release target");
const [os, arch] = platform.split("-");
if (
  (os === "darwin" ? "darwin" : "linux") !== process.platform ||
  (arch === "x86_64" ? "x64" : "arm64") !== process.arch
)
  throw new Error("Runner architecture does not match requested platform");
const gh = (...args) =>
  execFileSync("gh", [...args, "--repo", "techartdev/ShellCanvas"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
const bundle = resolve("target/release/bundle");
const scratch = resolve(".local/platform-release");
const directory = resolve(scratch, "artifacts");
await mkdir(directory, { recursive: true });
const bundledNames = await readdir(bundle, { recursive: true });
for (const name of bundledNames.filter((name) =>
  /\.(?:AppImage|deb|rpm|dmg|app\.tar\.gz|sig)$/.test(name),
)) {
  // Tauri macOS archives have the same basename on Intel and Apple silicon.
  // Prefix both the payload and signature; signing covers bytes, not filenames.
  await copyFile(
    resolve(bundle, name),
    resolve(directory, `${platform}-${basename(name)}`),
  );
}
gh("release", "download", tag, "--pattern", "latest.json", "--dir", scratch);
const previous = JSON.parse(
  await readFile(resolve(scratch, "latest.json"), "utf8"),
);
const update = await manifest({
  version: tag.slice(1),
  os,
  arch,
  directory,
  previous,
});
const names = await readdir(directory, { recursive: true });
const files = names.filter((name) =>
  /\.(?:AppImage|deb|rpm|dmg|app\.tar\.gz|sig)$/.test(name),
);
if (!files.length) throw new Error("No release packages found");
const sums = [];
for (const name of files) {
  const file = resolve(directory, name);
  sums.push(
    `${createHash("sha256")
      .update(await readFile(file))
      .digest("hex")}  ${basename(name)}`,
  );
  // Existing versioned assets must never be silently replaced.
  gh("release", "upload", tag, file);
}
const checksum = resolve(scratch, `SHA256SUMS-${platform}.txt`);
await writeFile(checksum, sums.join("\n") + "\n");
gh("release", "upload", tag, checksum);
const output = resolve(scratch, "latest.json");
await writeFile(output, JSON.stringify(update, null, 2) + "\n");
// Only advertise new targets after every package is present.
gh("release", "upload", tag, output, "--clobber");
