// SPDX-License-Identifier: MPL-2.0
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { PanelsTopLeft } from "lucide-react";
import { AppWindow } from "../../src/components/AppWindow";
import { SystemDialogHost } from "../../src/components/SystemDialogHost";
import { bindSession } from "../../src/session-services";
import { previewServices, previewSession } from "../../src/preview";
import { defineApps, type AppContext, type Directory } from "../../src/sdk";
import "../../src/styles.css";
function Sample({ system }: AppContext) {
  const [result, setResult] = useState(
    "System APIs without app-owned dialog markup.",
  );
  async function run(action: () => Promise<unknown>) {
    try {
      setResult(JSON.stringify(await action()));
    } catch (error) {
      setResult(String(error));
    }
  }
  return (
    <section style={{ padding: 28, display: "grid", gap: 14 }}>
      <h2>System API workbench</h2>
      <p>Fake device. No real host is contacted.</p>
      <button
        onClick={() =>
          void run(() =>
            system!.dialogs.messageBox({
              title: "Ready to publish?",
              message:
                "This is a reusable ShellCanvas message box. Your app supplies the content and actions; the desktop owns its presentation and lifetime.",
              buttons: [
                { id: "cancel", label: "Keep editing" },
                { id: "publish", label: "Publish" },
              ],
              defaultId: "cancel",
              cancelId: "cancel",
            }),
          )
        }
      >
        Message box
      </button>
      <button
        onClick={() =>
          void run(() =>
            system!.dialogs.openFile({
              title: "Open a document",
              multiple: true,
              extensions: [".txt", ".md"],
            }),
          )
        }
      >
        Open documents
      </button>
      <button
        onClick={() =>
          void run(() =>
            system!.dialogs.openFile({
              title: "Choose a folder",
              kind: "directory",
            }),
          )
        }
      >
        Choose folder
      </button>
      <button
        onClick={() =>
          void run(() =>
            system!.dialogs.saveFile({
              title: "Save destination",
              name: "notes.txt",
            }),
          )
        }
      >
        Choose save destination
      </button>
      <button
        onClick={() =>
          void run(() =>
            system!.files.saveTextAs({
              title: "Save notes",
              name: "readme.txt",
              text: "Saved through the system API",
            }),
          )
        }
      >
        Save text with replacement review
      </button>
      <p role="status" style={{ overflowWrap: "anywhere", fontSize: 12 }}>
        {result}
      </p>
    </section>
  );
}
const [app] = defineApps([
  {
    apiVersion: 1,
    id: "fixture.system",
    title: "API workbench",
    subtitle: "System services",
    scope: "host",
    requires: ["files.read"],
    optional: ["files.create", "files.edit"],
    icon: PanelsTopLeft,
    component: Sample,
  },
]);
function Fixture() {
  const [events, setEvents] = useState<string[]>([]);
  const binding = useMemo(
    () =>
      bindSession(
        {
          ...previewServices,
          list: async (_, path) => {
            if (path && !["node@root", "node@docs"].includes(path))
              throw new Error("This fixture uses opaque node locations.");
            return {
              path: path ?? "node@root",
              name: path === "node@docs" ? "Documents" : "Workspace",
              parent: path === "node@docs" ? "node@root" : null,
              home: { name: "Home", path: "node@root" },
              roots: [{ name: "Device", path: "node@root" }],
              entries:
                path === "node@docs"
                  ? []
                  : [
                      {
                        name: "Documents",
                        path: "node@docs",
                        kind: "directory",
                        size: 0,
                        modified: null,
                        revision: "r1",
                      },
                      {
                        name: "readme.txt",
                        path: "file@readme",
                        kind: "file",
                        size: 256,
                        modified: null,
                        revision: "r1",
                      },
                      {
                        name: "design.md",
                        path: "file@design",
                        kind: "file",
                        size: 1024,
                        modified: null,
                        revision: "r1",
                      },
                      {
                        name: "wallpaper.png",
                        path: "file@image",
                        kind: "file",
                        size: 2048,
                        modified: null,
                        revision: "r1",
                      },
                    ],
            } as Directory;
          },
          readText: async () => ({
            path: "file@readme",
            name: "readme.txt",
            parent: "node@root",
            text: "original",
            revision: "text-r1",
            writable: true,
          }),
          saveText: async (_, path, text, revision) => {
            setEvents((old) => [...old, `Saved ${path} with ${revision}`]);
            return {
              path,
              name: "readme.txt",
              parent: "node@root",
              text,
              revision: "text-r2",
              writable: true,
            };
          },
          createText: async (_, parent, name, text) => {
            setEvents((old) => [...old, `Created ${name} in ${parent}`]);
            return {
              path: "file@new",
              name,
              parent,
              text,
              revision: "text-new",
              writable: true,
            };
          },
        },
        {
          ...previewSession,
          info: {
            ...previewSession.info,
            capabilities: ["files.read", "files.create", "files.edit"],
          },
        },
      ),
    [],
  );
  const session = {
    ...previewSession,
    info: {
      ...previewSession.info,
      capabilities: ["files.read", "files.create", "files.edit"] as const,
    },
  };
  return (
    <>
      <div
        style={{
          height: "calc(100vh - 90px)",
          position: "relative",
          margin: 20,
        }}
      >
        <AppWindow
          app={app}
          focused
          visible
          order={0}
          focus={() => {}}
          minimize={() => {}}
          close={() => {}}
          context={{
            session: {
              ...session,
              info: {
                ...session.info,
                capabilities: [...session.info.capabilities],
              },
            },
            services: binding.services,
            preview: true,
            connect() {},
            reportError() {},
          }}
        />
      </div>
      <pre style={{ margin: 20 }}>{events.join("\n")}</pre>
      <SystemDialogHost />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
