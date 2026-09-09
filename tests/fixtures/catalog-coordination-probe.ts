// SPDX-License-Identifier: MPL-2.0
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import {
  AppCatalog,
  indexedCatalogStorage,
  type AppLease,
} from "../../src/extensions/catalog";

const delay = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10_000;
  while (!(await test())) {
    if (Date.now() > end) throw new Error("Catalog coordination timed out");
    await delay();
  }
}
const raw = (version: string, permissions: string[] = []) =>
  JSON.stringify({
    format: 1,
    kind: "app",
    id: "org.example.coordination",
    version,
    title: "Coordination fixture",
    permissions,
    script: "void 0",
    style: "",
  });
async function run() {
  const checks: Record<string, boolean> = {};
  const leases: AppLease[] = [];
  let stop: (() => void) | undefined;
  let channel: BroadcastChannel | undefined;
  let announce: ReturnType<typeof setInterval> | undefined;
  try {
    const context = await invoke<{
      role: "owner" | "peer";
      run: string;
      pid: number;
    }>("catalog_probe_context");
    const catalog = new AppCatalog(
      indexedCatalogStorage(`shellcanvas-catalog-probe-${context.run}`),
    );
    const messages = new Map<string, Record<string, unknown>>();
    channel = new BroadcastChannel(
      `shellcanvas-catalog-probe-control-${context.run}`,
    );
    channel.onmessage = (event) => {
      if (event.data && typeof event.data.type === "string")
        messages.set(event.data.type, event.data);
    };
    const send = (type: string, data = {}) =>
      channel!.postMessage({ type, ...data });
    const failures: unknown[] = [];
    stop = catalog.watch((error) => failures.push(String(error)));
    await catalog.load();
    if (context.role === "peer") {
      announce = setInterval(() => send("ready", { pid: context.pid }), 40);
      await until(() => catalog.snapshot()[0]?.package.version === "1.0.0");
      clearInterval(announce);
      checks.remoteInstall = true;
      const first = await catalog.launch("org.example.coordination");
      leases.push(first);
      send("opened");
      await until(() => catalog.snapshot()[0]?.package.version === "2.0.0");
      checks.remoteUpdate = true;
      const second = await catalog.launch("org.example.coordination");
      leases.push(second);
      checks.generationPinned =
        first.installed.package.version === "1.0.0" &&
        second.installed.package.version === "2.0.0";
      checks.grantsPinned =
        first.installed.grants.includes("system.dialogs") &&
        second.installed.grants.length === 0;
      send("updated");
      await until(() => catalog.snapshot()[0]?.enabled === false);
      try {
        const unexpected = await catalog.launch("org.example.coordination");
        unexpected.close();
      } catch (error) {
        checks.remoteDisable = String(error).includes("disabled");
      }
      checks.disableKeepsWindows = !first.closed && !second.closed;
      send("disabled");
      await until(() => messages.has("release"));
      for (const lease of leases.splice(0)) lease.close();
      // Wait until this process has actually released its locks, not just the JS handles.
      await until(
        async () =>
          !(await navigator.locks.query()).held?.some(
            (lock) =>
              lock.mode === "shared" && lock.name?.includes(context.run),
          ),
      );
      send("released");
      await until(() => catalog.snapshot().length === 0);
      checks.remoteRemoval = true;
      send("removed");
      await until(() => catalog.snapshot()[0]?.package.version === "3.0.0");
      leases.push(await catalog.launch("org.example.coordination"));
      send("crash-ready", { checks, pid: context.pid, failures });
      // The runner terminates this process; do not voluntarily release this lease.
      await new Promise(() => {});
    } else {
      await until(() => messages.has("ready"));
      checks.separateProcesses = messages.get("ready")!.pid !== context.pid;
      await catalog.install(
        await catalog.review(raw("1.0.0", ["system.dialogs"])),
        ["system.dialogs"],
      );
      await until(() => messages.has("opened"));
      const second = await catalog.install(
        await catalog.review(raw("2.0.0")),
        [],
      );
      await until(() => messages.has("updated"));
      await catalog.setEnabled(second.package.id, second.generation, false);
      await until(() => messages.has("disabled"));
      try {
        await catalog.remove(second.package.id, second.generation);
      } catch (error) {
        checks.foreignWindowsBlockRemoval =
          String(error).includes("running windows");
      }
      send("release");
      await until(() => messages.has("released"));
      await catalog.remove(second.package.id, second.generation);
      await until(() => messages.has("removed"));
      const third = await catalog.install(
        await catalog.review(raw("3.0.0")),
        [],
      );
      await until(() => messages.has("crash-ready"));
      const peer = messages.get("crash-ready")!;
      Object.assign(checks, peer.checks);
      checks.noWatchErrors =
        failures.length === 0 &&
        Array.isArray(peer.failures) &&
        peer.failures.length === 0;
      await emit("shellcanvas-native-extension-progress", {
        stage: "terminate-catalog-peer",
        pid: peer.pid,
      });
      await until(async () => {
        try {
          await catalog.remove(third.package.id, third.generation);
          return true;
        } catch (error) {
          if (String(error).includes("running windows")) return false;
          throw error;
        }
      });
      checks.crashReleasesLease = catalog.snapshot().length === 0;
      await emit("shellcanvas-native-extension-probe", {
        success:
          Object.values(checks).every(Boolean) &&
          Object.keys(checks).length === 11,
        checks,
        pid: context.pid,
      });
    }
  } catch (error) {
    await emit("shellcanvas-native-extension-probe", {
      success: false,
      checks,
      error: String(error),
    });
  } finally {
    if (announce) clearInterval(announce);
    for (const lease of leases) lease.close();
    stop?.();
    channel?.close();
  }
}
void run();
