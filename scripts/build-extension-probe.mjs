// SPDX-License-Identifier: MPL-2.0
import { build as bundle } from "esbuild";
import { build } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
const source = await bundle({
  entryPoints: ["tests/fixtures/native-frame-probe-client.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  write: false,
});
await mkdir(".local/native-extension-probe", { recursive: true });
await writeFile(
  ".local/native-extension-probe/client.js",
  source.outputFiles[0].text,
);
const desktop = await bundle({
  entryPoints: ["tests/fixtures/desktop-probe-client.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  write: false,
});
await writeFile(
  ".local/native-extension-probe/desktop-client.js",
  desktop.outputFiles[0].text,
);
await build({
  build: {
    outDir: ".local/native-extension-probe/dist",
    emptyOutDir: true,
    rollupOptions: {
      input: [
        resolve("tests/fixtures/native-frame-probe.html"),
        resolve("tests/fixtures/native-desktop-probe.html"),
        resolve("tests/fixtures/adapter-desktop-probe.html"),
      ],
    },
  },
});
