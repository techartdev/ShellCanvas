// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import {
  inspectRepository,
  parseRepositoryLocation,
  type RepositoryReader,
} from "./repository";
import { parseAppRepository } from "../../packages/app-sdk/src/repository";
const raw = JSON.stringify({
  format: 1,
  kind: "app",
  id: "org.example.assistant",
  version: "1.0.0",
  title: "Assistant",
  permissions: [],
  script: "throw new Error('must not execute')",
  style: "",
});
async function fixture(
  changes: Record<string, unknown> = {},
  packageRaw = raw,
) {
  const sha256 = [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const manifest = {
    format: 1,
    kind: "app-repository",
    id: "org.example.assistant",
    version: "1.0.0",
    title: "Assistant",
    description: "A tool",
    package: { path: "dist/app.shellcanvas.json", sha256 },
    ...changes,
  };
  const read = vi.fn<RepositoryReader>(async (_, path) =>
    path === "shellcanvas.repo.json" ? JSON.stringify(manifest) : packageRaw,
  );
  return { read, manifest };
}
it("fetches only the descriptor and artifact, checks exact bytes without executing code", async () => {
  const f = await fixture();
  const result = await inspectRepository(
    "https://github.com/example/assistant.git",
    "v1.0.0",
    new AbortController().signal,
    f.read,
  );
  expect(result.raw).toBe(raw);
  expect(result.source).toEqual({
    owner: "example",
    repository: "assistant",
    ref: "v1.0.0",
    sha256: f.manifest.package.sha256,
  });
  expect(f.read.mock.calls.map((call) => call[1])).toEqual([
    "shellcanvas.repo.json",
    "dist/app.shellcanvas.json",
  ]);
});
it("rejects corrupt bytes and mismatched package identity", async () => {
  for (const f of [
    await fixture({}, raw + " "),
    await fixture({ id: "org.other.app" }),
    await fixture({ version: "2.0.0" }),
  ])
    await expect(
      inspectRepository(
        "example/app",
        "main",
        new AbortController().signal,
        f.read,
      ),
    ).rejects.toThrow();
});
it("rejects unsafe repositories, references, paths and unknown descriptor fields", async () => {
  for (const value of [
    "https://evil.test/a/b",
    "user/repo?token=secret",
    "../repo",
    "user/repo/path",
    "user@host/repo",
  ])
    expect(() => parseRepositoryLocation(value)).toThrow();
  for (const path of [
    "../secret",
    "/absolute",
    "dist/../secret",
    "dist\\package.json",
    "https://evil.test/app",
    "dist/a?b",
    "dist/a%2fb",
    "a//b",
  ]) {
    expect(() => parseRepositoryLocation("user/repo", path)).toThrow();
    const f = await fixture({ package: { path, sha256: "a".repeat(64) } });
    await expect(
      inspectRepository(
        "user/repo",
        "main",
        new AbortController().signal,
        f.read,
      ),
    ).rejects.toThrow();
    expect(f.read).toHaveBeenCalledTimes(1);
  }
  const f = await fixture({ execute: "evil" });
  expect(() => parseAppRepository(JSON.stringify(f.manifest))).toThrow();
});
it("does not fetch an artifact after cancellation or return canceled verification", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const read: RepositoryReader = async (...args) => {
    const value = await f.read(...args);
    controller.abort();
    return value;
  };
  await expect(
    inspectRepository("user/repo", "main", controller.signal, read),
  ).rejects.toThrow();
  expect(f.read).toHaveBeenCalledTimes(1);
});
