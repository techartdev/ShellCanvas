// SPDX-License-Identifier: MPL-2.0
import { expect, it } from "vitest";
import { appDocument, parseAppPackage } from "./package";
import {
  APP_ICON_MAX_BYTES,
  parseAppManifest,
} from "../../packages/app-sdk/src/package";
const data = (type: string, bytes: string) =>
  `data:${type};base64,${btoa(bytes)}`;
const png = (size = 12) =>
  data("image/png", "\x89PNG\r\n\x1a\n" + "\0".repeat(size - 8));
const svg = data(
  "image/svg+xml",
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>',
);
const manifest = {
  format: 1,
  kind: "app",
  id: "org.example.notes",
  version: "1.0.0",
  title: "Notes",
  permissions: ["system.dialogs"],
  script: "document.body.dataset.loaded = 'yes'",
  style: "body {color:white}",
};
it("snapshots self-contained app packages without arbitrary markup or unknown fields", () => {
  const app = parseAppPackage(JSON.stringify(manifest));
  expect(Object.isFrozen(app)).toBe(true);
  expect(Object.isFrozen(app.permissions)).toBe(true);
  for (const change of [
    { format: 2 },
    { id: "../escape" },
    { permissions: ["system.dialogs", "system.dialogs"] },
    { entry: "https://untrusted.invalid/app.js" },
    { kind: "adapter" },
    { permissions: ["*"] },
  ]) {
    expect(() =>
      parseAppPackage(JSON.stringify({ ...manifest, ...change })),
    ).toThrow();
  }
});
it("accepts a one-line description and an embedded icon whose bytes match its declared type", () => {
  const parse = (change: object) =>
    parseAppPackage(JSON.stringify({ ...manifest, ...change }));
  const app = parse({ description: "Quick notes for your hosts", icon: svg });
  expect(app.description).toBe("Quick notes for your hosts");
  expect(app.icon).toBe(svg);
  for (const icon of [
    png(),
    svg,
    data("image/jpeg", "\xff\xd8\xff\xe0\0\x10"),
    data("image/webp", "RIFF\x10\0\0\0WEBPVP8 "),
    png(APP_ICON_MAX_BYTES),
  ])
    expect(() => parse({ icon })).not.toThrow();
  for (const change of [
    { description: "" },
    { description: "   " },
    { description: "x".repeat(161) },
    { description: "Two\nlines" },
    { description: 3 },
    { icon: "https://example.invalid/icon.png" },
    { icon: png().replace("image/png", "image/gif") },
    // Declared type and signature must agree.
    { icon: data("image/png", "<svg></svg>") },
    { icon: svg.replace("image/svg+xml", "image/png") },
    { icon: data("image/svg+xml", "<html>not an image</html>") },
    { icon: "data:image/png;base64,iVBO Rw0KGgo=" },
    { icon: `${png()}=` },
    { icon: png(APP_ICON_MAX_BYTES + 1) },
  ])
    expect(() => parse(change), JSON.stringify(change).slice(0, 80)).toThrow();
});
it("names a source icon file beside the manifest; packages embed it instead", () => {
  const { script: _script, style: _style, ...source } = manifest;
  const parse = (icon: unknown) =>
    parseAppManifest(JSON.stringify({ ...source, icon }));
  expect(parse("icon.svg").icon).toBe("icon.svg");
  expect(parse("assets/app-icon.png").icon).toBe("assets/app-icon.png");
  for (const icon of [
    svg,
    "../icon.png",
    "/icon.png",
    "assets\\icon.png",
    "icon.gif",
    "ICON.PNG",
    "",
  ])
    expect(() => parse(icon), String(icon).slice(0, 40)).toThrow();
  expect(() =>
    parseAppPackage(JSON.stringify({ ...manifest, icon: "icon.svg" })),
  ).toThrow();
});
it("keeps script/style closing tags inside package source rather than adding privileged markup", () => {
  const app = parseAppPackage(
    JSON.stringify({
      ...manifest,
      script: 'const name = "</script><script src=https://invalid.test>";',
      style: 'body::after { content: "</style><iframe>" }',
    }),
  );
  const html = appDocument(app, "safe-nonce");
  // The apparent second opening tag is text inside the still-open script element.
  expect(html).toContain("<\\/script><script src=https://invalid.test>");
  expect(html.match(/<\/script>/g)).toHaveLength(1);
  expect(html.match(/<\/style>/g)).toHaveLength(1);
  expect(html).toContain("connect-src 'none'");
  expect(() => appDocument(app, '" unsafe')).toThrow();
});
