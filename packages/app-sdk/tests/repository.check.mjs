// SPDX-License-Identifier: MPL-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Ajv from "ajv/dist/2020.js";
import { repositoryManifest } from "../bin/shellcanvas-app.mjs";
import { parseAppRepository } from "../dist/repository.js";
test("repository tooling fingerprints the artifact and agrees with the published schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "shellcanvas-repository-"));
  await mkdir(join(root, "dist"));
  const raw = JSON.stringify({
    format: 1,
    kind: "app",
    id: "org.example.app",
    version: "1.0.0",
    title: "App",
    permissions: [],
    script: "void 0",
    style: "",
  });
  await writeFile(join(root, "dist/app.shellcanvas.json"), raw);
  const path = await repositoryManifest(root, {
    description: "An independent app",
  });
  const generated = await readFile(path, "utf8");
  const manifest = parseAppRepository(generated);
  assert.equal(
    manifest.package.sha256,
    createHash("sha256").update(raw).digest("hex"),
  );
  const validate = new Ajv().compile(
    JSON.parse(
      await readFile(
        new URL("../schemas/app-repository.schema.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  assert.equal(validate(manifest), true);
  for (const patch of [
    { package: { path: "../outside", sha256: "a".repeat(64) } },
    { title: " " },
    { extra: "unknown" },
    { version: "next" },
  ]) {
    const value = { ...manifest, ...patch };
    assert.equal(validate(value), false);
    assert.throws(() => parseAppRepository(JSON.stringify(value)));
  }
  await assert.rejects(() => repositoryManifest(root, { path: "../outside" }));
  await writeFile(join(root, "dist/app.shellcanvas.json"), "broken");
  await assert.rejects(() => repositoryManifest(root));
  assert.equal(await readFile(path, "utf8"), generated);
});
