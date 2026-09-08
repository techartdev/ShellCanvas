// SPDX-License-Identifier: MPL-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { runChecks } from "./verification.mjs";

test("failed, missing or interrupted commands never start later checks or report success", () => {
  for (const failure of [
    { status: 2 },
    { error: new Error("ENOENT") },
    { status: 0, signal: "SIGTERM" },
  ]) {
    const called = [];
    let saved;
    const passed = runChecks(
      [{ name: "first" }, { name: "second" }, { name: "third" }],
      (check) => {
        called.push(check.name);
        return check.name === "first" ? { status: 0 } : failure;
      },
      (results) => {
        saved = structuredClone(results);
      },
    );
    assert.equal(passed, false);
    assert.deepEqual(called, ["first", "second"]);
    assert.deepEqual(
      saved.map((result) => result.status),
      ["passed", "failed", "not-run"],
    );
  }
});

test("an executor exception is recorded as failure; report preserves incomplete runs", () => {
  const snapshots = [];
  assert.equal(
    runChecks(
      [{ name: "first" }],
      () => {
        throw new Error("launch failed");
      },
      (results) => snapshots.push(structuredClone(results)),
    ),
    false,
  );
  assert.deepEqual(
    snapshots.map((results) => results[0].status),
    ["not-run", "running", "failed"],
  );
  assert.match(snapshots.at(-1)[0].error, /launch failed/);
});

test("success requires every requested check to complete successfully", () => {
  let saved;
  assert.equal(
    runChecks(
      [{ name: "test" }, { name: "build" }],
      () => ({ status: 0 }),
      (results) => {
        saved = structuredClone(results);
      },
    ),
    true,
  );
  assert.deepEqual(
    saved.map((result) => result.status),
    ["passed", "passed"],
  );
});
