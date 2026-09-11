// SPDX-License-Identifier: MPL-2.0
import Ajv from "ajv";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
/** The exported crate directory is named after the manifest version. */
export function adapterSdkVersion(repo) {
  const version = readFileSync(
    join(repo, "crates/adapter-sdk/Cargo.toml"),
    "utf8",
  ).match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error("Adapter SDK version not found.");
  return version;
}
export function checkAdapterSchemas(source, project, packaged) {
  const ajv = new Ajv();
  for (const [kind, directory] of [
    ["source", project],
    ["package", packaged],
  ]) {
    const validate = ajv.compile(
      JSON.parse(
        readFileSync(
          join(source, `schemas/adapter-${kind}.schema.json`),
          "utf8",
        ),
      ),
    );
    const manifest = JSON.parse(
      readFileSync(join(directory, "adapter.json"), "utf8"),
    );
    assert.ok(validate(manifest), JSON.stringify(validate.errors));
    assert.equal(validate({ ...manifest, unknown: true }), false);
    assert.equal(
      validate({
        ...manifest,
        configuration: [
          { id: "token", label: "Token", kind: "password", default: "secret" },
        ],
      }),
      false,
    );
    assert.equal(
      validate({
        ...manifest,
        configuration: [
          { id: "port", label: "Port", kind: "number", default: "wrong type" },
        ],
      }),
      false,
    );
    if (kind === "package")
      assert.equal(
        validate({
          ...manifest,
          files: manifest.files.map((file) => ({ ...file, sha256: "bad" })),
        }),
        false,
      );
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const report = JSON.parse(
    readFileSync(
      new URL(
        "../.local/adapter-sdk-verification/latest.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(report.success, true);
  checkAdapterSchemas(
    join(
      report.root,
      `shellcanvas-adapter-sdk-${adapterSdkVersion(fileURLToPath(new URL("..", import.meta.url)))}`,
    ),
    join(report.root, "generated device"),
    join(report.root, "generated package"),
  );
  console.log(
    "Exported adapter schemas passed valid-artifact and rejection checks.",
  );
}
