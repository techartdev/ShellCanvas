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
  type AdapterConnectionOptions,
  type SourceReplacement,
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
import type { ServiceMethodInfo } from "@shellcanvas/app-sdk";
import customScript from "../../.local/native-extension-probe/custom-client.js?raw";
import customStyle from "../../examples/service-inspector/style.css?raw";
import "../../src/styles.css";
const native = isTauri(),
  checks: Record<string, boolean> = {},
  sessions: Session[] = [],
  terminals = new Map<number, TerminalSession>(),
  output = new Map<number, string>();
const connectionOptions: AdapterConnectionOptions[] = [];
const replacements: SourceReplacement[] = [];
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
      id: "transfers",
      label: "Transfers (download, upload or both)",
      kind: "text",
      default: "",
      required: false,
    },
    {
      id: "folders",
      label: "Folder transfers",
      kind: "boolean",
      default: false,
      required: false,
    },
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
    {
      id: "extended",
      label: "Text, file changes and settings",
      kind: "boolean",
      default: false,
      required: false,
    },
  ],
});
const fake: AdapterServices = {
  replaceSource: async () => {
    throw new Error("Use the Windows fixture to apply a replacement.");
  },
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
    connectionOptions.push(options);
    return session;
  },
  ...(native
    ? {
        replaceSource: async (
          ...args: Parameters<NonNullable<AdapterServices["replaceSource"]>>
        ) => {
          const result = await nativeAdapterServices.replaceSource!(...args);
          replacements.push(result);
          return result;
        },
      }
    : {}),
};
const transport: HostServices = native
  ? nativeServices
  : {
      ...previewServices,
      terminal: async (_id, _cols, _rows, onEvent) => ({
        write: async (text) =>
          onEvent({
            type: "output",
            data: Array.from(
              typeof text === "string" ? new TextEncoder().encode(text) : text,
            ),
          }),
        resize: async () => {},
        close: async () => {},
      }),
    };
function instrument(transport: HostServices): HostServices {
  return {
    ...transport,
    bindSources: transport.bindSources
      ? (session) => instrument(transport.bindSources!(session))
      : undefined,
    profiles: async () => [],
    terminal: async (id, cols, rows, onEvent) => {
      const handle = await transport.terminal(id, cols, rows, (event) => {
        if (event.type === "output")
          output.set(
            id,
            (output.get(id) ?? "") +
              new TextDecoder().decode(new Uint8Array(event.data)),
          );
        return onEvent(event);
      });
      terminals.set(id, handle);
      return handle;
    },
  };
}
const services = instrument(transport);
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
async function replacementForm(labelText: string) {
  await named("Switch workspace");
  const choice = await until(
    () =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".workspace-switcher button",
        ),
      ].find(
        (button) => button.querySelector("strong")?.textContent === labelText,
      ),
    "replace source choice",
  );
  choice.click();
  return until(
    () => document.querySelector<HTMLDialogElement>(".adapter-connect"),
    "source replacement form",
  );
}
async function cleanup() {
  for (const session of sessions)
    await services.disconnect(session.id).catch(() => {});
  for (const item of await adapterServices.list())
    if (item.id === packageId)
      await adapterServices.remove(item.id, item.revision);
  await runtime.catalog.load();
  for (const item of runtime.catalog.snapshot())
    if (
      ["org.example.custom-denied", "org.example.custom-granted"].includes(
        item.package.id,
      )
    )
      await runtime.catalog.remove(item.package.id, item.generation);
}
type CustomReply = { value?: unknown; code?: string; error?: string };
async function askCustom(
  frame: HTMLIFrameElement,
  action: string,
  method?: string,
): Promise<CustomReply> {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.contentWindow ||
        event.data?.type !== "custom-service-result" ||
        event.data.id !== id
      )
        return;
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      resolve(event.data);
    };
    const timer = setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("Custom-service frame did not answer"));
    }, 5000);
    window.addEventListener("message", receive);
    frame.contentWindow?.postMessage(
      { type: "custom-service-probe", id, action, method },
      "*",
    );
  });
}
async function installCustom(granted: boolean) {
  const title = granted ? "Device Services granted" : "Device Services denied";
  const picker = await until(
    () =>
      document.querySelector<HTMLInputElement>(
        'input[aria-label="Select app package"]',
      ),
    "app picker",
  );
  const data = new DataTransfer();
  data.items.add(
    new File(
      [
        JSON.stringify({
          format: 1,
          kind: "app",
          id: granted
            ? "org.example.custom-granted"
            : "org.example.custom-denied",
          version: "1.0.0",
          title,
          permissions: ["services.acme", "files.read", "system.console"],
          script: customScript,
          style: customStyle,
        }),
      ],
      "device-services.shellcanvas.json",
      { type: "application/json" },
    ),
  );
  picker.files = data.files;
  picker.dispatchEvent(new Event("change", { bubbles: true }));
  const review = await until(
    () => document.querySelector(".extension-review"),
    "app permission review",
  );
  const permission = await label(
    "Use acme services on the selected connection",
    review,
  );
  if (!granted) {
    permission.click();
    (await label("Open and control remote consoles", review)).click();
  }
  await click("Install app", review);
  const card = await until(
    () =>
      Array.from(document.querySelectorAll(".extension-list article")).find(
        (item) =>
          item.querySelector("h3")?.textContent?.trim().startsWith(title),
      ),
    "custom app card",
  );
  await click("Open app", card);
  const frame = await until(
    () => document.querySelector<HTMLIFrameElement>(`iframe[title="${title}"]`),
    "custom frame",
  );
  await until(() => frame.getAttribute("src"), "native app document");
  // Read-only readiness retries; a native frame URL can precede script startup.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await askCustom(frame, "list");
      return frame;
    } catch {
      if (attempt === 2) throw new Error("Custom app failed to initialize");
    }
  }
  throw new Error("Custom app failed to initialize");
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
  if (
    !native &&
    new URL(location.href).searchParams.get("inspect") &&
    new URL(location.href).searchParams.get("inspect") !== "replacement"
  ) {
    document.body.dataset.probeStage = "installed";
    return;
  }
  let form = await openConnections();
  input(await label("Workspace name", form), "Adapter playground");
  input(await label("Example private token", form), "synthetic-token");
  input(await label("Additional services", form), "acme");
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
  if (native) {
    await named("Open Text editor");
    const editor = await until(
      () => document.querySelector<HTMLElement>(".editor-app"),
      "text editor",
    );
    checks.browsingOnlyEditor =
      editor
        .querySelector(".editor-offline")
        ?.textContent?.includes("does not provide text documents") === true &&
      editor.querySelector<HTMLButtonElement>(
        'button[aria-label="Browse remote files"]',
      )?.disabled === true &&
      [...editor.querySelectorAll<HTMLButtonElement>("button")]
        .filter((button) => button.textContent?.trim() === "Open")
        .every((button) => button.disabled);
    editor
      .closest(".app-window")!
      .querySelector<HTMLButtonElement>(
        'button[aria-label^="Close Text editor"]',
      )!
      .click();
  }
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
  let customFrame: HTMLIFrameElement | undefined;
  let originalBinding: string | undefined;
  if (native) {
    await named("Open Apps");
    await click("Desktop apps");
    const denied = await installCustom(false);
    const discovery = (await askCustom(denied, "list"))
      .value as ServiceMethodInfo[];
    checks.customPermissionDiscovery = discovery.some(
      (item) =>
        item.name === "acme.echo" &&
        item.available &&
        !item.granted &&
        !!item.source,
    );
    checks.customPermissionDenied =
      (await askCustom(denied, "call")).code === "denied";
    checks.consolePermissionDenied =
      (await askCustom(denied, "console")).code === "denied";
    (
      await until(
        () =>
          document.querySelector<HTMLButtonElement>(
            'button[aria-label^="Close Device Services denied"]',
          ),
        "close denied app",
      )
    ).click();
    customFrame = await installCustom(true);
    const consoleResult = (await askCustom(customFrame, "console")).value as
      { bytes?: boolean; survivor?: boolean } | undefined;
    checks.sdkConsoleBytes = consoleResult?.bytes === true;
    checks.sdkConsoleIndependentClose = consoleResult?.survivor === true;
    const catalog = (await askCustom(customFrame, "list"))
      .value as ServiceMethodInfo[];
    checks.textOperationUnavailable =
      catalog.find((method) => method.name === "system.files.readText")
        ?.granted === true &&
      catalog.find((method) => method.name === "system.files.readText")
        ?.available === false &&
      (await askCustom(customFrame, "text")).code === "unavailable";
    const browsed = (await askCustom(customFrame, "browse")).value;
    checks.browsingOperationAvailable =
      catalog.find((method) => method.name === "system.files.listStart")
        ?.available === true &&
      Array.isArray(browsed) &&
      browsed.length > 0;
    originalBinding = catalog.find((item) => item.name === "acme.echo")?.source;
    checks.customSdkEcho =
      JSON.stringify((await askCustom(customFrame, "call")).value) ===
      JSON.stringify({ message: "fixture", nested: [1, true, null] });
    checks.customAdapterError =
      (await askCustom(customFrame, "call", "acme.fail")).code === "denied";
    checks.customCancellation =
      (await askCustom(customFrame, "cancel")).code === "aborted";
    const methods = await services.custom!.list(sessions[0].id);
    const count = methods.find((item) => item.name === "acme.cancelCount")!;
    checks.customCancellationReachedProcess =
      Number(
        await services.custom!.call(
          sessions[0].id,
          count.binding,
          count.name,
          null,
        ),
      ) > 0;
    await closeApps();
    await stage("custom-services");
  }
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
  if (customFrame) {
    const unavailable = (await askCustom(customFrame, "list"))
      .value as ServiceMethodInfo[];
    checks.customDisconnectDiscovery = unavailable.some(
      (item) => item.name === "acme.echo" && !item.available,
    );
  }
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
  if (customFrame) {
    checks.customReconnectNeedsReview =
      (await askCustom(customFrame, "call")).code === "unavailable";
    await click("Use reconnected host");
    checks.sdkConsoleOldHandleRetired =
      (await askCustom(customFrame, "console-stale")).code === "closed";
    const renewedConsole = (await askCustom(customFrame, "console")).value as
      { bytes?: boolean } | undefined;
    checks.sdkConsoleNewBinding = renewedConsole?.bytes === true;
    const updated = (await askCustom(customFrame, "list"))
      .value as ServiceMethodInfo[];
    const method = updated.find((item) => item.name === "acme.echo");
    checks.customReconnectFreshBinding =
      !!method?.source &&
      method.source !== originalBinding &&
      method.available &&
      !(await askCustom(customFrame, "call")).error;
    const accepted = nativeServices.bindSources!(sessions[1]);
    const before = replacements.length;
    const replaceForm = await replacementForm(
      "Replace Files + Terminal + acme connection",
    );
    checks.replacementOmitsSecrets =
      (await label("Example private token", replaceForm)).value === "";
    await click("Replace connection", replaceForm);
    await until(
      () =>
        replacements.length === before + 1 &&
        !document.querySelector(".adapter-connect"),
      "custom source replaced",
    );
    checks.customOldDiscoveryCannotFollow =
      (await accepted.custom!.list(sessions[1].id)).length === 0;
    checks.customReplacementNeedsReview =
      (await askCustom(customFrame, "call")).code === "unavailable";
    await click("Use reconnected host");
    const replacementMethods = (await askCustom(customFrame, "list"))
      .value as ServiceMethodInfo[];
    checks.customReplacementAccepted =
      replacementMethods.some(
        (item) =>
          item.name === "acme.echo" &&
          item.source !== method?.source &&
          item.available,
      ) && !(await askCustom(customFrame, "call")).error;
    (
      await until(
        () =>
          document.querySelector<HTMLButtonElement>(
            'button[aria-label^="Close Device Services granted"]',
          ),
        "close granted app",
      )
    ).click();
  }
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
    checks.pinnedFileRequest =
      (await nativeServices.bindSources!(sessions[2]).list(sessions[2].id))
        .entries.length > 0;
    checks.staleSourceRequestDenied = await invoke("list_directory", {
      sessionId: sessions[2].id,
      binding: { ...fileSource!, generation: fileSource!.generation + 1 },
    }).then(
      () => false,
      (error) => String(error).includes("connection changed"),
    );
    checks.foreignSourceRequestDenied = await invoke("list_directory", {
      sessionId: sessions[2].id,
      binding: consoleSource,
    }).then(
      () => false,
      (error) => String(error).includes("connection changed"),
    );
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
  if (
    !native &&
    new URL(location.href).searchParams.get("inspect") === "replacement"
  ) {
    await replacementForm("Replace Files connection");
    document.body.dataset.probeStage = "replacement-form";
    return;
  }
  if (native) {
    const original = sessions[2];
    const source = original.connections![0];
    const options = connectionOptions[2];
    const selected = options.sources[0];
    const candidate = {
      ...options,
      sources: [selected],
      bindings: { files: selected.key },
    };
    const before = await services.status!(original.id);
    checks.failedReplacementPreservesWorkspace =
      await nativeAdapterServices.replaceSource!(
        original.id,
        { ...source, generation: source.generation + 1 },
        candidate,
      ).then(
        () => false,
        () => true,
      );
    const afterFailure = await services.status!(original.id);
    checks.failedReplacementKeepsRevision =
      before?.sourceRevision === afterFailure?.sourceRevision;
    const controller = new AbortController();
    controller.abort();
    checks.canceledReplacementPreservesWorkspace =
      await nativeAdapterServices.replaceSource!(
        original.id,
        source,
        candidate,
        controller.signal,
      ).then(
        () => false,
        () => true,
      );
    const count = replacements.length;
    const form = await replacementForm("Replace Files connection");
    input(await label("Sample file count", form), "7");
    await click("Replace connection", form);
    await until(
      () =>
        replacements.length === count + 1 &&
        !document.querySelector(".adapter-connect"),
      "file source replaced",
    );
    const result = replacements.at(-1)!;
    checks.independentReplacementIdentity =
      result.sourceRevision === 1 &&
      result.connections[0].instance !== source.instance &&
      result.connections[1].instance === original.connections![1].instance;
    checks.independentReplacementKeepsTerminal =
      terminals.get(original.id) === mixed;
    await mixed.write("after file replacement\r\n");
    await until(
      () => output.get(original.id)?.includes("after file replacement"),
      "surviving terminal after source replacement",
    );
    checks.independentReplacementConsoleIO = true;
    const rebound = nativeServices.bindSources!({ ...original, ...result });
    checks.replacementFileContents =
      (await rebound.list(original.id)).entries.length === 7;
    checks.oldFileBindingRetired = await nativeServices.bindSources!(original)
      .list(original.id)
      .then(
        () => false,
        () => true,
      );
    await stage("source-replacement");
  }
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
    await named("Open Apps");
    await click("Connection adapters");
    const extendedForm = await openConnections();
    input(await label("Workspace name", extendedForm), "Extended device");
    const extendedSource = await until(
      () =>
        extendedForm.querySelector<HTMLElement>('[aria-label="Connection 1"]'),
      "extended source",
    );
    (await label("Text, file changes and settings", extendedSource)).click();
    (await label("Remote settings", extendedSource)).click();
    input(
      await label("Transfers (download, upload or both)", extendedSource),
      "both",
    );
    input(await label("Sample file count", extendedSource), "3");
    (await label("Folder transfers", extendedSource)).click();
    const before = sessions.length;
    await click("Open workspace", extendedForm);
    await until(
      () =>
        sessions.length === before + 1 &&
        !document.querySelector(".adapter-connect"),
      "extended workspace",
    );
    const extended = sessions.at(-1)!;
    const bound = nativeServices.bindSources!(extended);
    checks.extendedCapabilities = (
      [
        "files.read",
        "files.create",
        "files.edit",
        "files.manage",
        "files.move",
        "host.settings",
        "files.upload",
        "files.download",
        "files.copy",
        "files.folders",
      ] as const
    ).every((capability) => extended.info.capabilities.includes(capability));
    const original = await bound.readText(extended.id, "opaque:note");
    const saved = await bound.saveText(
      extended.id,
      original.path,
      "Native adapter note 🌿",
      original.revision,
    );
    checks.adapterTextRoundtrip =
      saved.text === "Native adapter note 🌿" &&
      saved.revision !== original.revision &&
      (await bound.readText(extended.id, original.path)).text === saved.text;
    checks.adapterTextConflict = await bound
      .saveText(extended.id, original.path, "stale", original.revision)
      .then(
        () => false,
        () => true,
      );
    const created = await bound.createText(
      extended.id,
      "opaque:actions",
      "created.txt",
      "New document",
    );
    const folder = await bound.makeDirectory(
      extended.id,
      "opaque:actions",
      "Folder",
    );
    const entry = (
      await bound.list(extended.id, "opaque:actions")
    ).entries.find((entry) => entry.path === created.path)!;
    const renamed = await bound.renameEntry(
      extended.id,
      entry.path,
      "renamed.txt",
      entry.revision!,
      [],
    );
    const renamedEntry = (
      await bound.list(extended.id, "opaque:actions")
    ).entries.find((entry) => entry.path === renamed.path)!;
    const moved = await bound.moveEntry(
      extended.id,
      renamedEntry.path,
      folder,
      renamedEntry.revision!,
      [],
    );
    const movedEntry = (await bound.list(extended.id, folder)).entries.find(
      (entry) => entry.path === moved.path,
    )!;
    await bound.removeEntry(extended.id, movedEntry.path, movedEntry.revision!);
    checks.adapterFileActions =
      (await bound.list(extended.id, folder)).entries.length === 0 &&
      renamed.path !== entry.path &&
      moved.path !== renamed.path;
    const [setting] = await bound.readHostSettings(extended.id);
    const applied = await bound.applyHostSetting(
      extended.id,
      setting.id,
      "quiet",
      setting.revision!,
    );
    checks.adapterSettingsRoundtrip =
      applied.value === "quiet" &&
      (await bound.readHostSettings(extended.id))[0].value === "quiet";
    checks.adapterSettingsConflict = await bound
      .applyHostSetting(extended.id, setting.id, "normal", setting.revision!)
      .then(
        () => false,
        () => true,
      );
    await stage("extended-adapter-services");
    const copy = await bound.prepareCopy(
      extended.id,
      "blob",
      "1",
      "opaque:destination",
    );
    const progress: number[] = [];
    const copied = await bound.runTransfer(extended.id, copy.id, (event) =>
      progress.push(event.bytes),
    );
    checks.adapterTransferCopy =
      copied.status === "completed" &&
      copied.bytes === 100_003 &&
      progress.length > 0;
    const folderCopy = await bound.prepareCopy(
      extended.id,
      "tree",
      "1",
      "opaque:folder-target",
    );
    const folderCopied = await bound.runTransfer(
      extended.id,
      folderCopy.id,
      () => {},
    );
    checks.adapterFolderCopy =
      folderCopied.status === "completed" && folderCopied.bytes === 0;
    checks.adapterTransferConflict = await bound
      .prepareCopy(extended.id, "blob", "stale", "opaque:destination")
      .then(
        () => false,
        () => true,
      );
    await stage("adapter-transfers");
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
