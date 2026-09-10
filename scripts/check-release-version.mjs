// SPDX-License-Identifier: MPL-2.0
import { readFile } from "node:fs/promises";

const expected = (process.argv[2] ?? process.env.GITHUB_REF_NAME ?? "").replace(/^v/, "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(expected)) {
  throw new Error("Pass a vX.Y.Z release tag or set GITHUB_REF_NAME");
}
const json = async (path) => JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
const rootPackage = await json("package.json");
const appSdk = await json("packages/app-sdk/package.json");
const tauri = await json("src-tauri/tauri.conf.json");
const cargoVersion = async (path) => {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  return source.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
};
const versions = {
  "package.json": rootPackage.version,
  "packages/app-sdk/package.json": appSdk.version,
  "src-tauri/tauri.conf.json": tauri.version,
  "crates/adapter-sdk/Cargo.toml": await cargoVersion("crates/adapter-sdk/Cargo.toml"),
  "crates/filesystem-sdk/Cargo.toml": await cargoVersion("crates/filesystem-sdk/Cargo.toml"),
};
for (const [path, version] of Object.entries(versions)) {
  if (version !== expected) throw new Error(`${path} is ${version}; expected ${expected}`);
}
console.log(`Release versions agree: ${expected}`);
