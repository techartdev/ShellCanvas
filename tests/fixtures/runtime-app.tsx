// SPDX-License-Identifier: MPL-2.0
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ExtensionFrame } from "../../src/extensions/ExtensionFrame";
import { parseAppPackage, type AppPackage } from "../../src/extensions/package";
import { SystemScope } from "../../src/system-dialogs";
import { SystemDialogHost } from "../../src/components/SystemDialogHost";
import { bindSession } from "../../src/session-services";
import { previewServices, previewSession } from "../../src/preview";
import type { HostServices, TextDocument } from "../../src/sdk";
import "../../src/styles.css";

const documents = new Map<string, TextDocument>();
const session = {
  ...previewSession,
  info: {
    ...previewSession.info,
    capabilities: ["files.read", "files.create"] as const,
  },
};
const fakeServices: HostServices = {
  ...previewServices,
  async list(id, path) {
    const directory = await previewServices.list(id, path);
    return {
      ...directory,
      entries: [
        ...directory.entries,
        ...[...documents.values()]
          .filter((item) => item.parent === directory.path)
          .map((item) => ({
            name: item.name,
            path: item.path,
            kind: "file" as const,
            revision: item.revision,
            size: new TextEncoder().encode(item.text).length,
            modified: null,
          })),
      ],
    };
  },
  async createText(id, parent, name, text) {
    const directory = await fakeServices.list(id, parent);
    if (directory.entries.some((item) => item.name === name))
      throw new Error("Destination already exists.");
    const result = {
      name,
      parent,
      path: `${parent}/${name}`,
      text,
      writable: true,
      revision: "fixture-1",
    };
    documents.set(result.path, result);
    return result;
  },
};

function Loaded({ app }: { app: AppPackage }) {
  const binding = useMemo(
    () =>
      bindSession(fakeServices, {
        ...session,
        info: { ...session.info, capabilities: [...session.info.capabilities] },
      }),
    [app],
  );
  const scope = useMemo(
    () =>
      new SystemScope(
        app.title,
        binding.services,
        (capability) => app.permissions.includes(capability),
        () => {},
      ),
    [app, binding],
  );
  useEffect(() => {
    binding.activate();
    scope.activate();
    return () => {
      scope.dispose();
      binding.dispose();
    };
  }, [scope, binding]);
  return (
    <ExtensionFrame app={app} system={scope.api} grants={app.permissions} />
  );
}
function Workbench() {
  const [app, setApp] = useState<AppPackage | null>(null);
  const [error, setError] = useState("");
  const load = async (read: () => Promise<string>) => {
    try {
      setApp(parseAppPackage(await read()));
      setError("");
    } catch (failure) {
      setError(String(failure));
    }
  };
  return (
    <main
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        padding: 24,
        gap: 16,
      }}
    >
      <header
        style={{
          display: "flex",
          gap: 16,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <strong>Runtime app workbench</strong>
        <button
          onClick={() =>
            void load(async () => {
              const response = await fetch(
                "/examples/dialog-app/dist/app.shellcanvas.json",
              );
              if (!response.ok)
                throw new Error(
                  "Build the sample with node scripts/pack-app.mjs first.",
                );
              return response.text();
            })
          }
        >
          Load built sample
        </button>
        <label>
          Load package{" "}
          <input
            aria-label="Load app package"
            type="file"
            accept=".json"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void load(() => file.text());
              event.currentTarget.value = "";
            }}
          />
        </label>
        <button onClick={() => setApp(null)} disabled={!app}>
          Unload app
        </button>
      </header>
      <p>
        Development fixture · fake device · package permissions are
        automatically granted here.
      </p>
      {error && <p role="alert">{error}</p>}
      <section
        style={{
          flex: 1,
          minHeight: 0,
          border: "1px solid #3b535f",
          borderRadius: 16,
          overflow: "hidden",
        }}
      >
        {app ? (
          <Loaded app={app} />
        ) : (
          <p style={{ padding: 24 }}>
            Load an independently built package without restarting the desktop.
          </p>
        )}
      </section>
      <SystemDialogHost />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Workbench />);
