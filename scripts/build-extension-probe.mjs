// SPDX-License-Identifier: MPL-2.0
import { build as bundle } from "esbuild";
import { build } from "vite";
import { mkdir, writeFile, readFile } from "node:fs/promises";
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
const desktop =
  process.env.SHELLCANVAS_SDK_PROBE === "1"
    ? {
        outputFiles: [
          {
            text: JSON.parse(
              await readFile(
                ".local/sdk-verification/desktop-probe.shellcanvas.json",
                "utf8",
              ),
            ).script,
          },
        ],
      }
    : await bundle({
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
const custom =
  process.env.SHELLCANVAS_SDK_PROBE === "1"
    ? {
        outputFiles: [
          {
            text: JSON.parse(
              await readFile(
                ".local/sdk-verification/custom-probe.shellcanvas.json",
                "utf8",
              ),
            ).script,
          },
        ],
      }
    : await bundle({
        entryPoints: ["tests/fixtures/custom-service-client.ts"],
        bundle: true,
        format: "iife",
        platform: "browser",
        target: "es2022",
        write: false,
      });
await writeFile(
  ".local/native-extension-probe/custom-client.js",
  custom.outputFiles[0].text,
);
await build({
  build: {
    outDir: ".local/native-extension-probe/dist",
    emptyOutDir: true,
    rollupOptions: {
      input: [
        resolve("tests/fixtures/native-frame-probe.html"),
        resolve("tests/fixtures/native-desktop-probe.html"),
        resolve("tests/fixtures/catalog-coordination-probe.html"),
        resolve("tests/fixtures/adapter-desktop-probe.html"),
        resolve("tests/fixtures/source-switch-probe.html"),
        resolve("tests/fixtures/connection-ui-probe.html"),
        resolve("tests/fixtures/live-image-clipboard-probe.html"),
        ...(process.env.SHELLCANVAS_SDK_PROBE === "1"
          ? [resolve("tests/fixtures/sdk-starter-probe.html")]
          : []),
      ],
    },
  },
});
