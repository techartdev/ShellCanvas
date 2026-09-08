// SPDX-License-Identifier: MPL-2.0
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AppCatalog,
  indexedCatalogStorage,
  type AppLease,
} from "../../src/extensions/catalog";
import { ExtensionManager } from "../../src/extensions/ExtensionManager";
import { ExtensionWindow } from "../../src/extensions/ExtensionWindow";
import { bindSession } from "../../src/session-services";
import { previewServices, previewSession } from "../../src/preview";
import { SystemDialogHost } from "../../src/components/SystemDialogHost";
import "../../src/styles.css";
const catalog = new AppCatalog(
  indexedCatalogStorage("shellcanvas-runtime-catalog-fixture"),
);
function Workbench() {
  const [leases, setLeases] = useState<readonly AppLease[]>([]);
  const [stack, setStack] = useState<readonly string[]>([]);
  const [manager, setManager] = useState(true);
  const [minimized, setMinimized] = useState<readonly string[]>([]);
  const [error, setError] = useState("");
  const live = useRef(leases);
  live.current = leases;
  const binding = useMemo(
    () => bindSession(previewServices, previewSession),
    [],
  );
  useEffect(() => {
    binding.activate();
    return () => {
      for (const lease of live.current) lease.close();
      binding.dispose();
    };
  }, [binding]);
  function focus(lease: AppLease) {
    // Moving an iframe DOM node reloads it. Keep mount order fixed; change z-order only.
    setStack((current) => [
      ...current.filter((id) => id !== lease.id),
      lease.id,
    ]);
    setMinimized((current) => current.filter((id) => id !== lease.id));
    setManager(false);
  }
  function launch(lease: AppLease) {
    setLeases((current) => [...current, lease]);
    setStack((current) => [...current, lease.id]);
    setManager(false);
  }
  return (
    <main
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "#152a35",
      }}
    >
      <nav
        aria-label="Workbench windows"
        className="extension-actions"
        style={{ padding: "12px 20px", borderBottom: "1px solid #3b5360" }}
      >
        <button onClick={() => setManager(true)}>Apps</button>
        {leases.map((lease) => (
          <button key={lease.id} onClick={() => focus(lease)}>
            {lease.installed.package.title} {lease.installed.package.version}
          </button>
        ))}
        <span style={{ marginLeft: "auto", color: "#96aeba", fontSize: 11 }}>
          Development workbench · sample host
        </span>
      </nav>
      {error && <p role="alert">{error}</p>}
      <section
        style={{
          flex: 1,
          minHeight: 0,
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div hidden={!manager} style={{ height: "100%", overflow: "auto" }}>
          <ExtensionManager
            catalog={catalog}
            launch={launch}
            sample={async () => {
              const response = await fetch(
                "/examples/dialog-app/dist/app.shellcanvas.json",
                { cache: "no-store" },
              );
              if (!response.ok)
                throw new Error("Build the sample package first.");
              return response.text();
            }}
          />
        </div>
        <div
          className="workspace-windows"
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: manager ? "none" : undefined,
          }}
        >
          {leases.map((lease) => (
            <ExtensionWindow
              key={lease.id}
              lease={lease}
              context={{
                session: previewSession,
                services: binding.services,
                preview: true,
                connected: true,
                connect: () => {},
                reportError: setError,
                openApp: (id) => {
                  try {
                    launch(catalog.launch(id));
                  } catch (failure) {
                    setError(String(failure));
                  }
                },
              }}
              order={stack.indexOf(lease.id)}
              focused={!manager && lease.id === stack.at(-1)}
              visible={!manager && !minimized.includes(lease.id)}
              focus={() => focus(lease)}
              minimize={() => {
                setMinimized((current) => [...current, lease.id]);
                setManager(true);
              }}
              close={() => {
                lease.close();
                setStack((current) => current.filter((id) => id !== lease.id));
                setLeases((current) =>
                  current.filter((item) => item !== lease),
                );
                setMinimized((current) =>
                  current.filter((id) => id !== lease.id),
                );
                setManager(true);
              }}
            />
          ))}
        </div>
      </section>
      <SystemDialogHost />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Workbench />);
