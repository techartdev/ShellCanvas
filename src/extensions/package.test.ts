// SPDX-License-Identifier: MPL-2.0
import { expect, it } from "vitest";
import { appDocument, parseAppPackage } from "./package";
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
