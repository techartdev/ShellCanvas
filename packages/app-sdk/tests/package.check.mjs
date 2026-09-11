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
    [{ clientPlatforms: ["windows", "macos", "linux"] }, true],
    [{ clientPlatforms: ["android", "ios", "web"] }, true],
    [{ clientPlatforms: [] }, false],
    [{ clientPlatforms: ["windows", "windows"] }, false],
    [{ clientPlatforms: ["unknown"] }, false],
    [{ clientPlatforms: "android" }, false],
    [{ clientPlatforms: null }, false],
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
    JSON.stringify({ ...manifest, clientPlatforms: ["windows", "android"] }),
  );
  await writeFile(
    join(directory, "main.ts"),
    'document.body.dataset.example = "yes";',
  );
  await writeFile(join(directory, "style.css"), "body { color: white; }");
  const output = await packApp(directory);
  const before = await readFile(output, "utf8");
  assert.equal(parseAppPackage(before).id, manifest.id);
  const platforms = parseAppPackage(before).clientPlatforms;
  assert.deepEqual(platforms, ["windows", "android"]);
  assert.ok(Object.isFrozen(platforms));
  await assert.rejects(packApp(directory, "bad"));
  await writeFile(join(directory, "main.ts"), 'import "./missing-file.js";');
  await assert.rejects(packApp(directory));
  assert.equal(await readFile(output, "utf8"), before);
  await writeFile(join(directory, "main.ts"), 'import "./style.css";');
  await assert.rejects(packApp(directory));
  assert.equal(await readFile(output, "utf8"), before);
});
const svgIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>';
const pngBytes = (size = 12) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(size - 8),
  ]);
test("schemas and the host parser agree on listing descriptions and icons", async () => {
  const ajv = new Ajv();
  const compile = async (name) =>
    ajv.compile(
      JSON.parse(await readFile(new URL(`../schemas/${name}`, import.meta.url))),
    );
  const sourceSchema = await compile("app-manifest.schema.json");
  const packageSchema = await compile("app-package.schema.json");
  const embedded = `data:image/svg+xml;base64,${Buffer.from(svgIcon).toString("base64")}`;
  for (const [patch, source, executable] of [
    [{ description: "Quick notes" }, true, true],
    [{ description: "é ✓ unicode" }, true, true],
    [{ description: "" }, false, false],
    [{ description: "   " }, false, false],
    [{ description: "x".repeat(161) }, false, false],
    [{ description: "two\nlines" }, false, false],
    [{ description: "next\u0085line" }, false, false],
    [{ description: "line\u2028separator" }, false, false],
    [{ description: "paragraph\u2029separator" }, false, false],
    [{ description: "c1\u009fcontrol" }, false, false],
    [{ icon: "icon.svg" }, true, false],
    [{ icon: "assets/icon.png" }, true, false],
    [{ icon: "../icon.png" }, false, false],
    [{ icon: "icon.gif" }, false, false],
    [{ icon: embedded }, false, true],
    [{ icon: "https://example.invalid/icon.png" }, false, false],
  ]) {
    const value = { ...manifest, ...patch };
    const packaged = { ...value, script: "void 0;", style: "" };
    const label = JSON.stringify(patch).slice(0, 60);
    assert.equal(sourceSchema(value), source, label);
    assert.equal(packageSchema(packaged), executable, label);
    if (source) assert.doesNotThrow(() => parseAppManifest(JSON.stringify(value)), label);
    else assert.throws(() => parseAppManifest(JSON.stringify(value)), label);
    if (executable) assert.doesNotThrow(() => parseAppPackage(JSON.stringify(packaged)), label);
    else assert.throws(() => parseAppPackage(JSON.stringify(packaged)), label);
  }
});
test("packer embeds the manifest icon and refuses oversized or mislabeled images", async (t) => {
  const directory = await fixture(t, "shellcanvas-sdk-icon-");
  const write = (icon, description) =>
    writeFile(
      join(directory, "shellcanvas.json"),
      JSON.stringify({ ...manifest, icon, description }),
    );
  await writeFile(join(directory, "main.ts"), "void 0;");
  await writeFile(join(directory, "style.css"), "");
  await writeFile(join(directory, "icon.svg"), svgIcon);
  await write("icon.svg", "Quick notes");
  const output = await packApp(directory);
  const packaged = parseAppPackage(await readFile(output, "utf8"));
  assert.equal(packaged.description, "Quick notes");
  assert.equal(
    packaged.icon,
    `data:image/svg+xml;base64,${Buffer.from(svgIcon).toString("base64")}`,
  );
  const before = await readFile(output, "utf8");
  await writeFile(join(directory, "big.png"), pngBytes(256 * 1024 + 1));
  await write("big.png", "Quick notes");
  await assert.rejects(packApp(directory), /larger than 256 KiB/);
  await writeFile(join(directory, "fake.png"), svgIcon);
  await write("fake.png", "Quick notes");
  await assert.rejects(packApp(directory), /not a valid PNG image/);
  await write("missing.png", "Quick notes");
  await assert.rejects(packApp(directory));
  assert.equal(await readFile(output, "utf8"), before);
  await writeFile(join(directory, "exact.png"), pngBytes(256 * 1024));
  await write("exact.png", "Quick notes");
  assert.ok(parseAppPackage(await readFile(await packApp(directory), "utf8")).icon);
});
