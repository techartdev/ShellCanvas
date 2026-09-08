// SPDX-License-Identifier: MPL-2.0
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
function asset(root, name) {
  if (
    !name ||
    /[\\:<>"|?*\x00-\x1f]/.test(name) ||
    name
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/.test(part) ||
          /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(
            part.split(".")[0].trimEnd(),
          ),
      )
  )
    throw new Error("Invalid package asset path");
  const result = resolve(root, name),
    local = relative(root, result);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
    throw new Error("Asset escapes package directory");
  return result;
}
export async function packAdapter(manifestPath, executable, output, version) {
  manifestPath = resolve(manifestPath);
  output = resolve(output);
  executable = executable ? resolve(executable) : undefined;
  const source = JSON.parse(await readFile(manifestPath, "utf8"));
  const platform =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "macos"
        : process.platform;
  const architecture =
    process.arch === "x64"
      ? "x86_64"
      : process.arch === "arm64"
        ? "aarch64"
        : process.arch;
  const expand = (value) =>
    value.replaceAll("{exe}", process.platform === "win32" ? ".exe" : "");
  const manifest = {
    ...source,
    version: version ?? source.version,
    platform:
      source.platform === "current"
        ? `${platform}-${architecture}`
        : source.platform,
    entrypoint: expand(source.entrypoint),
    files: [],
  };
  const paths = new Set();
  for (const declaration of source.files) {
    const path = expand(declaration.path);
    asset(output, path);
    const key = path.toLowerCase();
    if (key === "adapter.json" || paths.has(key))
      throw new Error("Duplicate or reserved package asset path");
    paths.add(key);
  }
  if (
    !source.files.some(
      (file) =>
        expand(file.path) === manifest.entrypoint && file.executable === true,
    )
  )
    throw new Error("The entrypoint must be a declared executable asset");
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output); // Refuse overwriting a previously packed version.
  for (const declaration of source.files) {
    const path = expand(declaration.path),
      destination = asset(output, path);
    const input =
      executable && path === manifest.entrypoint
        ? executable
        : asset(dirname(manifestPath), path);
    if (!(await lstat(input)).isFile())
      throw new Error("Package assets must be regular files");
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(input, destination);
    const digest = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(destination)) {
      digest.update(chunk);
      size += chunk.length;
    }
    manifest.files.push({
      path,
      size,
      sha256: digest.digest("hex"),
      executable: declaration.executable === true,
    });
  }
  await writeFile(
    resolve(output, "adapter.json"),
    JSON.stringify(manifest, null, 2) + "\n",
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
      "Usage: node scripts/pack-adapter.mjs manifest.json path/to/executable output-directory",
    );
  console.log(await packAdapter(manifest, executable, output));
}
