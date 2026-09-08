// SPDX-License-Identifier: MPL-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import Ajv from "ajv/dist/2020.js";
import { parseAppManifest, parseAppPackage } from "../dist/package.js";
import { createApp, packApp, main } from "../bin/shellcanvas-app.mjs";
const manifest = {
  format: 1,
  kind: "app",
  id: "org.example.notes",
  version: "1.0.0",
  title: "Notes",
  permissions: ["system.dialogs"],
};
async function fixture(t, prefix) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const parent = await realpath(tmpdir());
  t.after(async () => {
    if (
      (await realpath(root)) !== root ||
      dirname(root) !== parent ||
      !basename(root).startsWith(prefix)
    )
      throw new Error("Refusing cleanup outside the owned SDK test directory");
    await rm(root, { recursive: true });
  });
  return root;
}
test("schemas and the host parser agree on executable packages and source manifests", async () => {
  const ajv = new Ajv();
  const sourceSchema = ajv.compile(
    JSON.parse(
      await readFile(
        new URL("../schemas/app-manifest.schema.json", import.meta.url),
      ),
    ),
  );
  const packageSchema = ajv.compile(
    JSON.parse(
      await readFile(
        new URL("../schemas/app-package.schema.json", import.meta.url),
      ),
    ),
  );
  for (const [patch, valid] of [
    [{}, true],
    [{ format: 2 }, false],
    [{ kind: "adapter" }, false],
    [{ id: "../escape" }, false],
    [{ version: "1" }, false],
    [{ title: " " }, false],
    [{ title: "x".repeat(101) }, false],
    [{ permissions: ["*"] }, false],
    [{ permissions: ["system.dialogs", "system.dialogs"] }, false],
    [{ permissions: ["acme.router.read"] }, true],
    [{ entry: "https://example.invalid" }, false],
  ]) {
    const source = { ...manifest, ...patch },
      executable = { ...source, script: "void 0;", style: "" };
    assert.equal(sourceSchema(source), valid, JSON.stringify(patch));
    assert.equal(packageSchema(executable), valid, JSON.stringify(patch));
    for (const [parse, value] of [
      [parseAppManifest, source],
      [parseAppPackage, executable],
    ]) {
      if (valid) assert.doesNotThrow(() => parse(JSON.stringify(value)));
      else assert.throws(() => parse(JSON.stringify(value)));
    }
  }
  const editor = { ...manifest, $schema: "./schema.json" };
  assert.equal(sourceSchema(editor), true);
  assert.deepEqual(parseAppManifest(JSON.stringify(editor)), manifest);
  assert.throws(() =>
    parseAppPackage(
      JSON.stringify({ ...editor, script: "void 0;", style: "" }),
    ),
  );
  assert.throws(() =>
    parseAppManifest(JSON.stringify({ ...manifest, script: "void 0;" })),
  );
});
test("starter generation refuses existing projects and safely writes caller-supplied titles", async (t) => {
  const root = await fixture(t, "shellcanvas-sdk-generator-");
  const destination = join(root, "project");
  const title = 'Notes " <tag> ${literal}';
  await createApp(destination, { id: manifest.id, title });
  assert.ok(
    (await readFile(join(destination, "main.ts"), "utf8")).includes(
      JSON.stringify(title),
    ),
  );
  const original = await readFile(join(destination, "main.ts"), "utf8");
  await assert.rejects(
    createApp(destination, { id: manifest.id, title: "Replacement" }),
  );
  assert.equal(await readFile(join(destination, "main.ts"), "utf8"), original);
  await assert.rejects(createApp(join(root, "bad"), { id: "../bad", title }));
  await assert.rejects(
    main([
      "init",
      join(root, "bad"),
      "--id",
      manifest.id,
      "--title",
      "Notes",
      "--wat",
      "1",
    ]),
  );
});
test("packer preserves the last valid artifact after bad source, manifest or version", async (t) => {
  const directory = await fixture(t, "shellcanvas-sdk-packer-");
  await writeFile(
    join(directory, "shellcanvas.json"),
    JSON.stringify(manifest),
  );
  await writeFile(
    join(directory, "main.ts"),
    'document.body.dataset.example = "yes";',
  );
  await writeFile(join(directory, "style.css"), "body { color: white; }");
  const output = await packApp(directory);
  const before = await readFile(output, "utf8");
  assert.equal(parseAppPackage(before).id, manifest.id);
  await assert.rejects(packApp(directory, "bad"));
  await writeFile(join(directory, "main.ts"), 'import "./missing-file.js";');
  await assert.rejects(packApp(directory));
  assert.equal(await readFile(output, "utf8"), before);
  await writeFile(join(directory, "main.ts"), 'import "./style.css";');
  await assert.rejects(packApp(directory));
  assert.equal(await readFile(output, "utf8"), before);
});
