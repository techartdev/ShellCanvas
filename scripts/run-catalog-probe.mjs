// SPDX-License-Identifier: MPL-2.0
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".local/native-extension-probe");
for (const role of ["owner", "peer"])
  for (const suffix of ["result.json", "progress.jsonl"])
    await rm(resolve(directory, `catalog-${role}-${suffix}`), { force: true });
const run = randomUUID();
const children = [];
const launch = (role) => {
  const child = spawn(resolve(root, "target/debug/shellcanvas.exe"), [], {
    cwd: root,
    windowsHide: true,
    stdio: "inherit",
    env: {
      ...process.env,
      SHELLCANVAS_EXTENSION_PROBE: "1",
      SHELLCANVAS_CATALOG_ROLE: role,
      SHELLCANVAS_CATALOG_RUN: run,
    },
  });
  const state = { child, exited: false, error: undefined };
  state.done = new Promise((resolve) => {
    child.once("error", (error) => {
      state.error = error;
      state.exited = true;
      resolve();
    });
    child.once("exit", () => {
      state.exited = true;
      resolve();
    });
  });
  children.push(state);
  return state;
};
let killed = false;
try {
  const owner = launch("owner"),
    peer = launch("peer");
  const end = Date.now() + 35_000;
  while (!owner.exited) {
    if (Date.now() > end) throw new Error("Catalog probe timed out");
    if (owner.error || peer.error) throw owner.error ?? peer.error;
    let progress = "";
    try {
      progress = await readFile(
        resolve(directory, "catalog-owner-progress.jsonl"),
        "utf8",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const line of progress.split("\n").filter(Boolean)) {
      let item;
      try {
        item = JSON.parse(line);
      } catch {
        continue;
      }
      if (item.stage === "terminate-catalog-peer" && !killed) {
        if (item.pid !== peer.child.pid || peer.exited)
          throw new Error("Unexpected catalog peer process");
        killed = peer.child.kill();
        if (!killed) throw new Error("Unable to terminate the fixture peer");
      }
    }
    if (peer.exited && !killed)
      throw new Error("Catalog peer exited before the crash test");
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  const report = JSON.parse(
    await readFile(resolve(directory, "catalog-owner-result.json"), "utf8"),
  );
  if (!killed || !peer.exited || report.success !== true) {
    console.error(report);
    throw new Error("Catalog coordination failed");
  }
  const verified = { ...report, terminatedPeerPid: peer.child.pid, run };
  await writeFile(
    resolve(directory, "catalog-coordination-result.json"),
    JSON.stringify(verified, null, 2),
  );
  console.log(JSON.stringify(verified, null, 2));
} finally {
  for (const state of children) if (!state.exited) state.child.kill();
  await Promise.all(children.map((state) => state.done));
}
