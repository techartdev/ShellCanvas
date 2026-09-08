// SPDX-License-Identifier: MPL-2.0
import { build } from "esbuild";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const directory = resolve(process.argv[2] ?? "examples/dialog-app");
const manifest = JSON.parse(
  await readFile(join(directory, "shellcanvas.json"), "utf8"),
);
const result = await build({
  entryPoints: [join(directory, "main.ts")],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
});
const style = await readFile(join(directory, "style.css"), "utf8");
await mkdir(join(directory, "dist"), { recursive: true });
const destination = join(directory, "dist", "app.shellcanvas.json");
await writeFile(
  destination,
  JSON.stringify({ ...manifest, script: result.outputFiles[0].text, style }),
  "utf8",
);
console.log(`App package: ${destination}`);
