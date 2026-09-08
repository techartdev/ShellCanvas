// SPDX-License-Identifier: MPL-2.0
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import App from "../../src/App";
import {
  nativeAdapterServices,
  type AdapterInfo,
  type AdapterServices,
} from "../../src/adapters";
import { nativeServices } from "../../src/services";
import { previewServices, previewSession } from "../../src/preview";
import { apps } from "../../src/apps/registry";
import { DesktopRuntime } from "../../src/extensions/desktop-runtime";
import {
  AppCatalog,
  indexedCatalogStorage,
} from "../../src/extensions/catalog";
import type { HostServices, Session, TerminalSession } from "../../src/sdk";
import "../../src/styles.css";
const native = isTauri(),
  checks: Record<string, boolean> = {},
  sessions: Session[] = [],
  terminals = new Map<number, TerminalSession>(),
  output = new Map<number, string>();
let version = 1,
  installed: AdapterInfo[] = [];
const packageId = "dev.shellcanvas.adapter-probe";
const sample = (): AdapterInfo => ({
  id: packageId,
  name: "Practice device",
  version: `${version}.0.0`,
  description:
    "A synthetic device for trying adapter workspaces. It makes no remote network connections.",
  platform: "windows-x86_64",
  entrypoint: "bin/fixture-adapter.exe",
  generation: crypto.randomUUID(),
  revision: crypto.randomUUID(),
  enabled: true,
  fileCount: 1,
  bytes: 1773568,
  configuration: [
    {
      id: "standard",
      label: "Services (both, files or console)",
      kind: "text",
      default: "both",
      required: true,
    },
    {
      id: "entries",
      label: "Sample file count",
      kind: "number",
      default: 350,
      required: true,
    },
    {
      id: "resizable",
      label: "Resizable console",
      kind: "boolean",
      default: true,
      required: false,
    },
    {
      id: "token",
      label: "Example private token",
      kind: "password",
      required: false,
    },
  ],
});
const fake: AdapterServices = {
  list: async () => installed,
  review: async (requestId) => ({
    requestId,
    package: sample(),
    replaces: installed.length > 0,
  }),
  cancelReview: async () => {},
  install: async () => {
    const item = sample();
    installed = [item];
    return item;
  },
  setEnabled: async (id, revision, enabled) => {
    installed = installed.map((item) =>
      item.id === id
        ? { ...item, enabled, revision: crypto.randomUUID() }
        : item,
    );
    return installed[0];
  },
  remove: async () => {
    installed = [];
  },
  connect: async (options) => ({
    ...previewSession,
    id: 100 + sessions.length,
    connections: options.sources.map((source, index) => ({
      instance: index + 1,
      generation: 1,
      adapter: source.id,
    })),
    info: {
      ...previewSession.info,
      hostname: options.name,
      provider: "adapters",
      capabilities: ["files.read", "terminal"],
      notices: [],
    },
  }),
};
const adapterServices: AdapterServices = {
  ...(native ? nativeAdapterServices : fake),
  review: (requestId) =>
    native
      ? invoke("review_fixture_adapter", { requestId, version })
      : fake.review(requestId),
  connect: async (options, signal) => {
    const session = await (native ? nativeAdapterServices : fake).connect(
      options,
      signal,
    );
    sessions.push(session);
    return session;
  },
};
const transport: HostServices = native
  ? nativeServices
  : {
      ...previewServices,
      terminal: async (_id, _cols, _rows, onEvent) => ({
        write: async (text) =>
          onEvent({
            type: "output",
            data: Array.from(new TextEncoder().encode(text)),
          }),
        resize: async () => {},
        close: async () => {},
      }),
    };
const services: HostServices = {
  ...transport,
  profiles: async () => [],
  terminal: async (id, cols, rows, onEvent) => {
    const handle = await transport.terminal(id, cols, rows, (event) => {
      if (event.type === "output")
        output.set(
          id,
          (output.get(id) ?? "") +
            new TextDecoder().decode(new Uint8Array(event.data)),
        );
      onEvent(event);
    });
    terminals.set(id, handle);
    return handle;
  },
};
const runtime = new DesktopRuntime(
  new AppCatalog(indexedCatalogStorage("shellcanvas-adapter-probe-apps")),
  apps,
  undefined,
  undefined,
  adapterServices,
);
async function until<T>(
  read: () => T | undefined | false,
  label: string,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    const result = read();
    if (result) return result as NonNullable<T>;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}
const buttons = (text: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.trim() === text && !button.disabled,
  );
async function click(text: string, root: ParentNode = document) {
  (await until(() => buttons(text, root), text)).click();
}
async function named(label: string) {
  (
    await until(
      () =>
        document.querySelector<HTMLButtonElement>(
          `button[aria-label="${label}"]`,
        ),
      label,
    )
  ).click();
}
function input(element: HTMLInputElement, text: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(element, text);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}
async function label(text: string, root: ParentNode = document) {
  return until(
    () =>
      Array.from(root.querySelectorAll("label"))
        .find((label) => label.textContent?.startsWith(text))
        ?.querySelector<HTMLInputElement>("input"),
    text,
  );
}
async function stage(name: string) {
  if (native)
    await emit("shellcanvas-native-extension-progress", {
      stage: name,
      checks,
    });
  else console.log(name, checks);
}
async function install() {
  await click("Install adapter");
  const panel = await until(
    () =>
      document.querySelector<HTMLElement>(
        '[aria-label="Review native adapter"]',
      ),
    "native review",
  );
  checks.explicitTrust = Array.from(
    panel.querySelectorAll<HTMLButtonElement>("button"),
  ).some(
    (button) => button.disabled && button.textContent?.includes("adapter"),
  );
  panel.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  await click(
    version === 1 ? "Install trusted adapter" : "Update adapter",
    panel,
  );
  await until(
    () => !document.querySelector('[aria-label="Review native adapter"]'),
    "review consumed",
  );
  await until(
    () =>
      document
        .querySelector(".extension-card")
        ?.textContent?.includes(`${version}.0.0`),
    "installed version",
  );
}
async function openConnections() {
  await closeApps();
  await click(sessions.length ? "Add host" : "Connect a host");
  await click("Use connection adapters");
  return until(
    () => document.querySelector<HTMLDialogElement>(".adapter-connect"),
    "adapter form",
  );
}
async function closeApps() {
  (
    await until(
      () =>
        Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            'button[aria-label^="Close Apps"]',
          ),
        ).find((button) => button.getClientRects().length > 0),
      "close current Apps window",
    )
  ).click();
}
async function cleanup() {
  for (const session of sessions)
    await services.disconnect(session.id).catch(() => {});
  for (const item of await adapterServices.list())
    if (item.id === packageId)
      await adapterServices.remove(item.id, item.revision);
}
async function run() {
  await cleanup();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App
        services={services}
        isNative
        initialSession={null}
        appRuntime={runtime}
        adapterServices={adapterServices}
      />
    </StrictMode>,
  );
  await named("Open Apps");
  await click("Connection adapters");
  await install();
  await stage("installed");
  if (!native && new URL(location.href).searchParams.has("inspect")) {
    document.body.dataset.probeStage = "installed";
    return;
  }
  let form = await openConnections();
  input(await label("Workspace name", form), "Adapter playground");
  input(await label("Example private token", form), "synthetic-token");
  await click("Open workspace", form);
  await until(() => sessions.length === 1, "adapter session");
  await until(
    () => !document.querySelector(".adapter-connect"),
    "connected desktop",
  );
  await named("Open Files");
  await until(() => document.querySelector(".file-main"), "files window");
  const listing = await services.list(sessions[0].id);
  checks.installedFiles =
    listing.entries.length > 0 &&
    (native ? listing.path === "device://inventory?root=main" : true);
  await named("Open Terminal");
  const terminal = await until(
    () => terminals.get(sessions[0].id),
    "live adapter terminal",
  );
  await terminal.write("adapter echo\r\n");
  await until(
    () => output.get(sessions[0].id)?.includes("adapter echo"),
    "console echo",
  );
  checks.installedConsole = true;
  await named("Open Apps");
  await click("Connection adapters");
  version = 2;
  await install();
  const current = (await adapterServices.list()).find(
    (item) => item.id === packageId,
  )!;
  checks.updatedVersion = current.version === "2.0.0";
  await click("Disable");
  await until(
    () =>
      document
        .querySelector(".extension-card")
        ?.textContent?.includes("Disabled"),
    "disabled adapter",
  );
  await terminal.write("old generation\r\n");
  await until(
    () => output.get(sessions[0].id)?.includes("old generation"),
    "old connection after update/disable",
  );
  checks.pinnedRunningConnection = true;
  await click("Enable");
  await until(
    () =>
      document
        .querySelector(".extension-card")
        ?.textContent?.includes("Ready for new connections"),
    "enabled adapter",
  );
  await closeApps();
  await click("Disconnect");
  await click("Reconnect host");
  form = await until(
    () => document.querySelector<HTMLDialogElement>(".adapter-connect"),
    "reconnect form",
  );
  const privateToken = await label("Example private token", form);
  checks.reconnectOmitsSecrets = privateToken.value === "";
  input(privateToken, "new-synthetic-token");
  await click("Reconnect workspace", form);
  await until(() => sessions.length === 2, "reconnected session");
  const reconnected = await until(
    () => terminals.get(sessions[1].id),
    "reconnected console",
  );
  await reconnected.write("reconnected\r\n");
  await until(
    () => output.get(sessions[1].id)?.includes("reconnected"),
    "fresh console output",
  );
  checks.reconnectPreservesWindows =
    sessions[1].id !== sessions[0].id && !!document.querySelector(".file-main");
  if (native) {
    checks.oldConsoleRetired = await terminal.write("retired\r\n").then(
      () => false,
      () => true,
    );
  }
  await named("Open Apps");
  await click("Connection adapters");
  form = await openConnections();
  input(await label("Workspace name", form), "Mixed device");
  const first = await until(
    () => form.querySelector<HTMLElement>('[aria-label="Connection 1"]'),
    "first source loaded",
  );
  (await label("Terminal", first)).click();
  input(await label("Services (both, files or console)", first), "files");
  await click("Add another connection", form);
  const second = await until(
    () => form.querySelector<HTMLElement>('[aria-label="Connection 2"]'),
    "second source",
  );
  (await label("Terminal", second)).click();
  input(await label("Services (both, files or console)", second), "console");
  await click("Open workspace", form);
  await until(() => sessions.length === 3, "mixed session");
  await until(
    () => !document.querySelector(".adapter-connect"),
    "mixed desktop",
  );
  checks.independentBindings = sessions[2].connections?.length === 2;
  if (native) {
    const fileSource = sessions[2].services?.find(
      (service) => service.capability === "files.read",
    )?.source;
    const consoleSource = sessions[2].services?.find(
      (service) => service.capability === "terminal",
    )?.source;
    checks.explicitSourceIdentity =
      !!fileSource &&
      !!consoleSource &&
      fileSource.instance !== consoleSource.instance;
  }
  await services.list(sessions[2].id);
  await named("Open Terminal");
  const mixed = await until(
    () => terminals.get(sessions[2].id),
    "mixed terminal",
  );
  await mixed.write("mixed echo\r\n");
  await until(
    () => output.get(sessions[2].id)?.includes("mixed echo"),
    "mixed console output",
  );
  if (native) {
    const item = (await adapterServices.list()).find(
      (item) => item.id === packageId,
    )!;
    const limited = await adapterServices.connect({
      name: "Limited device",
      sources: [
        {
          key: "limited",
          id: item.id,
          revision: item.revision,
          configuration: { standard: "files" },
        },
      ],
      bindings: { files: "limited", console: "limited" },
    });
    checks.unsupportedCapabilities =
      limited.info.capabilities.includes("files.read") &&
      !limited.info.capabilities.includes("terminal") &&
      limited.services?.find((service) => service.capability === "terminal")
        ?.state === "unsupported";
  }
  await named("Open Apps");
  await click("Connection adapters");
  await click("Remove");
  await click(
    "Remove adapter",
    await until(
      () => document.querySelector('[aria-label="Remove adapter"]'),
      "remove confirmation",
    ),
  );
  await until(
    () => !document.querySelector(".extension-card"),
    "adapter removal",
  );
  checks.removedFromCatalog = !(await adapterServices.list()).some(
    (item) => item.id === packageId,
  );
  await mixed.write("survives removal\r\n");
  await until(
    () => output.get(sessions[2].id)?.includes("survives removal"),
    "connection after removal",
  );
  checks.removalKeepsConnections = true;
  await cleanup();
  await stage("complete");
  const result = { success: Object.values(checks).every(Boolean), checks };
  if (native) await emit("shellcanvas-native-extension-probe", result);
  else document.body.dataset.probeResult = JSON.stringify(result);
}
void run().catch(async (error) => {
  await cleanup().catch(() => {});
  const result = {
    success: false,
    error: String(error),
    stack: error instanceof Error ? error.stack : undefined,
    checks,
  };
  if (native) await emit("shellcanvas-native-extension-probe", result);
  else document.body.dataset.probeResult = JSON.stringify(result);
});
