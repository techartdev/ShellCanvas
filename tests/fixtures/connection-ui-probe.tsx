// SPDX-License-Identifier: MPL-2.0
// Real desktop/forms with synthetic connection services. No network or OS clipboard.
import { createRoot } from "react-dom/client";
import { emit } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import App from "../../src/App";
import { previewServices, previewSession } from "../../src/preview";
import { apps } from "../../src/apps/registry";
import {
  AppCatalog,
  indexedCatalogStorage,
} from "../../src/extensions/catalog";
import { DesktopRuntime } from "../../src/extensions/desktop-runtime";
import type {
  AdapterInfo,
  AdapterProfile,
  AdapterServices,
} from "../../src/adapters";
import {
  capabilityLabels,
  type HostServices,
  type HostKeyReviewer,
  type Session,
  type WorkspaceStatus,
} from "../../src/sdk";
import "../../src/styles.css";

const checks: Record<string, boolean> = {};
const disconnected: number[] = [];
const decisions: boolean[] = [];
let attempts = 0,
  terminalOpens = 0,
  terminalCloses = 0,
  replacements = 0;
let releaseLate: (() => void) | undefined;
let oldReviewer: HostKeyReviewer | undefined;
let current: Session | undefined;
let status: WorkspaceStatus | undefined;
const info = (id: string, name: string): AdapterInfo => ({
  id,
  name,
  version: "1.0.0",
  description: "Synthetic UI fixture",
  platform: id === "builtin:ssh" ? "builtin" : "windows-x64",
  entrypoint: "fixture",
  configuration: [],
  generation: "g1",
  revision: "r1",
  enabled: true,
  fileCount: 1,
  bytes: 1,
});
const files = info("org.example.files", "Fixture files");
const ssh = {
  ...info("builtin:ssh", "SSH"),
  configuration: [
    { id: "host", label: "Host", kind: "text" as const, required: true },
    {
      id: "port",
      label: "Port",
      kind: "number" as const,
      required: true,
      default: 22,
    },
    {
      id: "username",
      label: "Username",
      kind: "text" as const,
      required: true,
    },
  ],
};
const profile: AdapterProfile = {
  kind: "adapters",
  name: "Mixed UI fixture",
  sources: [
    { key: "files", id: files.id, revision: files.revision, configuration: {} },
    {
      key: "ssh",
      id: ssh.id,
      revision: ssh.revision,
      configuration: { host: "fixture.invalid", port: 22, username: "fixture" },
    },
  ],
  bindings: { files: "files", console: "ssh" },
};
function session(id: number): Session {
  const sources = [
    { instance: id * 10, generation: 1, adapter: files.id },
    { instance: id * 10 + 1, generation: 1, adapter: "ssh" },
  ];
  return {
    ...previewSession,
    id,
    sourceRevision: 1,
    connections: sources,
    customSources: {},
    info: {
      ...previewSession.info,
      hostname: profile.name,
      provider: "adapters",
      capabilities: ["files.read", "terminal"],
    },
    services: Object.keys(capabilityLabels).map((capability) => ({
      capability: capability as keyof typeof capabilityLabels,
      state:
        capability === "files.read" || capability === "terminal"
          ? "available"
          : "unsupported",
      source: sources[capability === "terminal" ? 1 : 0],
    })),
  };
}
const unavailable = async (): Promise<never> => {
  throw new Error("Not used by this fixture");
};
const adapters: AdapterServices = {
  available: async () => [files, ssh],
  list: async () => [files],
  review: unavailable,
  cancelReview: async () => {},
  install: unavailable,
  setEnabled: unavailable,
  remove: unavailable,
  profiles: {
    list: async () => [{ id: "mixed", revision: "r1", profile }],
    save: unavailable,
    remove: unavailable,
  },
  connect: async (options, _signal, review) => {
    const attempt = ++attempts;
    if (
      options.sources.length !== 2 ||
      options.bindings.files !== "files" ||
      options.bindings.console !== "ssh"
    )
      throw new Error("Composition changed in the form");
    const approved = await review!({
      token: `attempt-${attempt}`,
      host: "fixture.invalid",
      port: 22,
      algorithm: "ssh-ed25519",
      fingerprint: `SHA256:fixture-${attempt}`,
    });
    decisions.push(approved);
    if (!approved) throw new Error("Fixture host key was declined");
    const result = session(700 + attempt);
    if (attempt === 2) {
      oldReviewer = review;
      await new Promise<void>((resolve) => {
        releaseLate = resolve;
      });
      return result;
    }
    current = result;
    status = { connected: true, sourceRevision: 1, services: result.services! };
    return result;
  },
  replaceSource: async (id, expected, options) => {
    if (
      id !== current?.id ||
      expected.instance !== current.connections?.[0].instance ||
      options.sources.length !== 1
    )
      throw new Error("Wrong replacement owner");
    replacements++;
    const replacement = { ...expected, generation: expected.generation + 1 };
    current = {
      ...current,
      sourceRevision: 2,
      connections: [replacement, current.connections![1]],
      services: current.services!.map((service) =>
        service.source?.instance === expected.instance
          ? { ...service, source: replacement }
          : service,
      ),
    };
    status = {
      connected: true,
      sourceRevision: 2,
      services: current.services!,
    };
    return {
      ...status,
      sourceRevision: 2,
      connections: current.connections!,
      cleanupWarning:
        "Fixture: replacement applied; old connection cleanup needs attention.",
    };
  },
};
const backend: HostServices = {
  ...previewServices,
  systemFileClipboard: false,
  profiles: async () => [],
  disconnect: async (id) => {
    disconnected.push(id);
  },
  status: async () => status!,
  terminal: async (_id, _cols, _rows, onEvent) => {
    terminalOpens++;
    onEvent({
      type: "output",
      data: Array.from(new TextEncoder().encode("Synthetic console ready\r\n")),
    });
    return {
      write: async () => {},
      resize: async () => {},
      close: async () => {
        terminalCloses++;
      },
    };
  },
};
const runtime = new DesktopRuntime(
  new AppCatalog(
    indexedCatalogStorage(`shellcanvas-connection-ui-${crypto.randomUUID()}`),
  ),
  apps,
  undefined,
  undefined,
  adapters,
);
createRoot(document.getElementById("root")!).render(
  <App
    services={backend}
    initialSession={null}
    isNative={true}
    appRuntime={runtime}
    adapterServices={adapters}
  />,
);

async function until<T>(
  read: () => T | undefined | false | null,
  name: string,
): Promise<T> {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out: ${name}; ${document.querySelector('[role="alert"]')?.textContent ?? ""}`,
  );
}
async function button(text: string, root: ParentNode = document) {
  return until(
    () =>
      [...root.querySelectorAll<HTMLButtonElement>("button")].find(
        (item) =>
          item.textContent?.trim() === text &&
          item.getClientRects().length > 0 &&
          !item.disabled,
      ),
    text,
  );
}
async function named(name: string) {
  const target = await until(
    () =>
      document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`),
    name,
  );
  target.click();
}
async function review(attempt: number) {
  return until(() => {
    const panel = document.querySelector<HTMLElement>(".host-key-review");
    return panel?.textContent?.includes(`SHA256:fixture-${attempt}`)
      ? panel
      : undefined;
  }, `host review ${attempt}`);
}
async function approve(panel: HTMLElement) {
  panel.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
  (await button("Trust and connect", panel)).click();
}
async function run() {
  (await button("Connect a host")).click();
  (await button("Use connection adapters")).click();
  const form = await until(
    () => document.querySelector<HTMLDialogElement>(".adapter-connect"),
    "adapter dialog",
  );
  const picker = await until(
    () =>
      form.querySelector<HTMLSelectElement>(".workspace-profile-picker select"),
    "profile picker",
  );
  await until(
    () => [...picker.options].some((option) => option.value === "mixed"),
    "saved profile",
  );
  picker.value = "mixed";
  picker.dispatchEvent(new Event("change", { bubbles: true }));
  await until(
    () => form.querySelectorAll(".adapter-source").length === 2,
    "mixed sources",
  );
  checks.mixedProfileLoaded =
    form.textContent!.includes("Fixture files") &&
    form.textContent!.includes("SSH");
  (await button("Open workspace", form)).click();
  const first = await review(1);
  checks.trustRequiresExplicitCheck = [
    ...first.querySelectorAll<HTMLButtonElement>("button"),
  ].find((item) => item.textContent?.includes("Trust and connect"))!.disabled;
  checks.exactHostIdentity =
    first.textContent!.includes("fixture.invalid") &&
    first.textContent!.includes("ssh-ed25519");
  (await button("Cancel connection", first)).click();
  await button("Open workspace", form);
  checks.declinedTrustDoesNotConnect =
    decisions[0] === false &&
    !current &&
    !document.querySelector(".host-key-review");

  (await button("Open workspace", form)).click();
  await approve(await review(2));
  await until(() => !!releaseLate, "pending initialization");
  (await button("Cancel connection", form)).click();
  await button("Open workspace", form);
  checks.initializationCancelUnblocksForm = !current;
  (await button("Open workspace", form)).click();
  const third = await review(3);
  checks.staleReviewCannotReplaceNewPrompt =
    !(await oldReviewer!({
      token: "old-late",
      host: "old.invalid",
      port: 22,
      algorithm: "ssh-ed25519",
      fingerprint: "SHA256:old",
    })) &&
    third.isConnected &&
    !third.textContent!.includes("old.invalid");
  releaseLate!();
  await until(() => disconnected.includes(702), "late session cleanup");
  checks.lateSessionNotAdopted = !current && third.isConnected;
  await approve(third);
  await until(
    () => current?.id === 703 && !document.querySelector(".adapter-connect"),
    "mixed connection established",
  );
  const fileWindow = await until(
    () => document.querySelector<HTMLElement>(".files-app"),
    "mixed Files window",
  );
  await named("Open Terminal");
  const terminal = await until(
    () => document.querySelector<HTMLElement>(".xterm"),
    "mixed terminal",
  );
  await until(() => terminalOpens === 1, "console connected");
  checks.mixedServicesAvailable =
    !!fileWindow && decisions.join(",") === "false,true,true";

  await named("Switch workspace");
  (
    await until(
      () =>
        [
          ...document.querySelectorAll<HTMLButtonElement>(
            ".workspace-switcher button",
          ),
        ].find(
          (item) =>
            !item.disabled &&
            item.querySelector("strong")?.textContent?.trim() ===
              "Replace Files connection",
        ),
      "Files connection replacement action",
    )
  ).click();
  const replacementForm = await until(
    () => document.querySelector<HTMLDialogElement>(".adapter-connect"),
    "replacement form",
  );
  (await button("Replace connection", replacementForm)).click();
  await until(
    () => replacements === 1 && !document.querySelector(".adapter-connect"),
    "replacement committed",
  );
  await until(
    () =>
      document.body.textContent!.includes(
        "Fixture: replacement applied; old connection cleanup needs attention.",
      ),
    "cleanup warning",
  );
  checks.committedReplacementShowsCleanupWarning =
    current!.sourceRevision === 2;
  checks.replacementPreservesConsole =
    terminal.isConnected && terminalOpens === 1 && terminalCloses === 0;

  status = {
    ...status!,
    services: status!.services.map((service) =>
      service.capability === "files.read"
        ? { ...service, state: "disconnected", reason: "Fixture files offline" }
        : service,
    ),
  };
  await until(
    () => document.querySelector(".partial-status"),
    "partial workspace status",
  );
  checks.partialFailurePreservesWorkspace =
    !disconnected.includes(703) && terminal.isConnected && terminalCloses === 0;
  checks.partialFilesDisabled =
    !!fileWindow.querySelector(".app-unavailable") ||
    fileWindow.textContent!.includes("Fixture files offline") ||
    document.body.textContent!.includes("Fixture files offline");
  return {
    success: Object.values(checks).every(Boolean),
    checks,
    viewport: { width: innerWidth, height: innerHeight },
    scope:
      "Real desktop connection UI with synthetic SSH/adapter services; no network, trust-store writes or OS clipboard",
  };
}
void run()
  .catch((error) => ({
    success: false,
    checks,
    error: String(error),
    buttons: [...document.querySelectorAll<HTMLButtonElement>("button")]
      .filter((button) => button.getClientRects().length > 0)
      .map((button) => ({
        text: button.textContent?.trim(),
        label: button.getAttribute("aria-label"),
        disabled: button.disabled,
      })),
  }))
  .then(async (result) => {
    if (isTauri()) await emit("shellcanvas-native-extension-probe", result);
    else console.log(result);
  });
