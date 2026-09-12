// SPDX-License-Identifier: MPL-2.0
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function platformKey(os, arch, filename) {
  const kind =
    os === "windows"
      ? filename.endsWith(".msi")
        ? "msi"
        : filename.endsWith("-setup.exe")
          ? "nsis"
          : null
      : os === "darwin"
        ? filename.endsWith(".app.tar.gz")
          ? "app"
          : null
        : os === "linux"
          ? filename.endsWith(".AppImage")
            ? "appimage"
            : filename.endsWith(".deb")
              ? "deb"
              : filename.endsWith(".rpm")
                ? "rpm"
                : null
          : null;
  if (!kind || !["x86_64", "aarch64", "i686", "armv7"].includes(arch))
    throw new Error(`Unsupported updater artifact: ${os}/${arch}/${filename}`);
  return `${os}-${arch}-${kind}`;
}
export async function manifest({
  version,
  os,
  arch,
  directory,
  previous,
  notes = "",
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Expected a stable release version");
  if (previous && previous.version !== version)
    throw new Error("Cannot mix artifacts from different releases");
  const platforms = { ...previous?.platforms };
  const files = await readdir(directory, { recursive: true });
  let count = 0;
  const added = new Set();
  for (const path of files.filter((file) => file.endsWith(".sig"))) {
    const artifact = path.slice(0, -4);
    const name = basename(artifact);
    // Read the paired artifact too: never advertise an absent payload.
    await readFile(resolve(directory, artifact));
    const signature = (await readFile(resolve(directory, path), "utf8")).trim();
    if (!signature || !/^[A-Za-z0-9+/=]+$/.test(signature))
      throw new Error(`Invalid signature file: ${path}`);
    const key = platformKey(os, arch, name);
    if (added.has(key)) throw new Error(`Duplicate update target: ${key}`);
    added.add(key);
    platforms[key] = {
      signature,
      url: `https://github.com/techartdev/ShellCanvas/releases/download/v${version}/${encodeURIComponent(name)}`,
    };
    count++;
  }
  if (!count) throw new Error("No signed updater artifacts found");
  return {
    version,
    notes: notes || previous?.notes || "",
    pub_date: previous?.pub_date || new Date().toISOString(),
    platforms,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [version, os, arch, directory, output, prior] = process.argv.slice(2);
  const previous = prior
    ? JSON.parse(await readFile(prior, "utf8"))
    : undefined;
  const value = await manifest({
    version,
    os,
    arch,
    directory,
    previous,
    notes: `ShellCanvas ${version}. See https://github.com/techartdev/ShellCanvas/releases/tag/v${version} for release notes.`,
  });
  await writeFile(output, JSON.stringify(value, null, 2) + "\n");
}
