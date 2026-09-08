// SPDX-License-Identifier: MPL-2.0
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { previewServices, previewSession } from "../../src/preview";
import type { HostServices, HostSetting } from "../../src/sdk";
import "../../src/styles.css";
let values = [
  {
    id: "linux.hostname",
    label: "Static hostname",
    description:
      "The persistent name used by this Linux system. Saved connection addresses are managed separately.",
    value: "atlas",
    revision: "1",
    editor: "text",
    choices: [],
    writable: true,
    reason: null,
  },
  {
    id: "linux.timezone",
    label: "Timezone",
    description:
      "The host's timezone affects local timestamps and scheduled jobs. The desktop clock uses this device's timezone.",
    value: "Etc/UTC",
    revision: "1",
    editor: "select",
    choices: ["Etc/UTC", "Europe/Sofia", "America/New_York"],
    writable: true,
    reason: null,
  },
] satisfies HostSetting[];
let readOnly = false,
  missingTimezone = false,
  failChange = false;
let record = (_: string) => {};
const backend: HostServices = {
  ...previewServices,
  readHostSettings: async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return values.map((field) => ({
      ...field,
      writable: !readOnly && !(missingTimezone && field.editor === "select"),
      value: missingTimezone && field.editor === "select" ? null : field.value,
      reason: readOnly
        ? "Read only for this account. This provider currently supports changes through a root connection."
        : missingTimezone && field.editor === "select"
          ? "Unavailable: timezone tools are missing."
          : null,
    }));
  },
  applyHostSetting: async (session, id, value, revision) => {
    record(`apply ${session}: ${id} -> ${value}`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const field = values.find((field) => field.id === id)!;
    if (readOnly) throw Error("This account is read only");
    if (field.revision !== revision)
      throw Error(
        "This setting changed on the host. Refresh and review your change again.",
      );
    if (failChange) {
      failChange = false;
      throw Error(
        "The change was not confirmed. Refresh before retrying; the host may already have applied it.",
      );
    }
    if (id === "linux.hostname" && !/^[a-z0-9][a-z0-9.-]*$/.test(value))
      throw Error("Invalid hostname");
    field.value = value;
    field.revision = String(Number(field.revision) + 1);
    return { ...field };
  },
};
function Fixture() {
  const [events, setEvents] = useState<string[]>([]);
  record = (event) => setEvents((old) => [...old, event]);
  return (
    <>
      <App
        services={backend}
        initialSession={{
          ...previewSession,
          info: {
            ...previewSession.info,
            capabilities: [
              ...previewSession.info.capabilities,
              "host.settings",
            ],
          },
        }}
      />
      <details
        style={{
          position: "fixed",
          bottom: 4,
          left: 10,
          zIndex: 100,
          background: "#172430",
          fontSize: 10,
        }}
      >
        <summary>Settings fixture controls</summary>
        <button
          onClick={() => {
            values[0].value = "changed-elsewhere";
            values[0].revision = String(Number(values[0].revision) + 1);
          }}
        >
          Change hostname externally
        </button>
        <button
          onClick={() => {
            readOnly = !readOnly;
          }}
        >
          Toggle read-only account
        </button>
        <button
          onClick={() => {
            missingTimezone = !missingTimezone;
          }}
        >
          Toggle missing timezone tool
        </button>
        <button
          onClick={() => {
            failChange = true;
          }}
        >
          Fail next change
        </button>
        <pre aria-label="Settings events">{events.join("\n")}</pre>
      </details>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
