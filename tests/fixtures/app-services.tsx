// SPDX-License-Identifier: MPL-2.0
import { useLayoutEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { FileText } from "lucide-react";
import { AppWindow } from "../../src/components/AppWindow";
import { defineApps, type AppContext, type Capability } from "../../src/sdk";
import { bindSession } from "../../src/session-services";
import { previewServices, previewSession } from "../../src/preview";
import "../../src/styles.css";

function Probe({ services }: AppContext) {
  const [result, setResult] = useState(
    "Choose an action to inspect its result.",
  );
  async function run(action: () => Promise<unknown>) {
    try {
      setResult(`Succeeded: ${JSON.stringify(await action())}`);
    } catch (error) {
      setResult(String(error));
    }
  }
  return (
    <article style={{ padding: 24, display: "grid", gap: 16 }}>
      <h2>Declared service probe</h2>
      <p>This fixture uses a fake provider. No real host is contacted.</p>
      <button onClick={() => void run(() => services.list())}>
        Read sample directory
      </button>
      <button
        onClick={() =>
          void run(() =>
            services.saveText("object@sample", "Fixture edit", "r1"),
          )
        }
      >
        Attempt sample save
      </button>
      <button
        onClick={() =>
          void run(async () => {
            const terminal = await services.terminal(80, 24, () => {});
            await terminal.close();
            return "terminal opened";
          })
        }
      >
        Attempt terminal
      </button>
      <p role="status" style={{ overflowWrap: "anywhere" }}>
        {result}
      </p>
    </article>
  );
}
const common = {
  apiVersion: 1 as const,
  title: "Service probe",
  subtitle: "Bundled app declarations",
  icon: FileText,
  component: Probe,
};
const definitions = defineApps([
  { ...common, id: "fixture.reader", scope: "host", requires: ["files.read"] },
  {
    ...common,
    id: "fixture.editor",
    scope: "host",
    requires: ["files.read"],
    optional: ["files.edit"],
  },
  { ...common, id: "fixture.local", scope: "local", requires: [] },
]);
function Fixture() {
  const [index, setIndex] = useState(0);
  const [writable, setWritable] = useState(true);
  const [events, setEvents] = useState<string[]>([]);
  const backend = useMemo(() => {
    const record = (text: string) =>
      setEvents((old) => [...old.slice(-19), text]);
    return {
      ...previewServices,
      list: async () => {
        record("provider: list");
        return {
          path: "node@root",
          name: "Sample",
          parent: null,
          home: null,
          roots: [],
          entries: [],
        };
      },
      saveText: async () => {
        record("provider: save");
        return {
          path: "object@sample",
          name: "Sample",
          parent: "node@root",
          text: "Fixture edit",
          revision: "r2",
          writable: true,
        };
      },
      terminal: async () => {
        record("provider: terminal");
        return {
          write: async () => {},
          resize: async () => {},
          close: async () => {},
        };
      },
    };
  }, []);
  const session = useMemo(
    () => ({
      ...previewSession,
      id: writable ? 1401 : 1402,
      info: {
        ...previewSession.info,
        hostname: "Declaration fixture",
        capabilities: [
          "files.read",
          "terminal",
          ...(writable ? ["files.edit"] : []),
        ] as Capability[],
      },
    }),
    [writable],
  );
  const binding = useMemo(
    () => bindSession(backend, session),
    [backend, session],
  );
  useLayoutEffect(() => {
    binding.activate();
    return binding.dispose;
  }, [binding]);
  return (
    <main className="desktop">
      <div
        style={{
          position: "relative",
          zIndex: 100,
          padding: 16,
          display: "flex",
          gap: 20,
        }}
      >
        <label>
          App declaration{" "}
          <select
            aria-label="App declaration"
            value={index}
            onChange={(event) => setIndex(Number(event.target.value))}
          >
            <option value={0}>Reader: required read only</option>
            <option value={1}>Editor: read with optional write</option>
            <option value={2}>Local app: no remote services</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={writable}
            onChange={(event) => setWritable(event.target.checked)}
          />{" "}
          Host supports writes
        </label>
      </div>
      <div style={{ position: "absolute", inset: "70px 20px 120px" }}>
        <AppWindow
          key={index}
          app={definitions[index]}
          context={{
            session,
            services: binding.services,
            preview: true,
            connect: () => {},
            reportError: (message) => setEvents((old) => [...old, message]),
          }}
          focused
          visible
          order={0}
          focus={() => {}}
          minimize={() => {}}
          close={() => {}}
        />
      </div>
      <pre
        aria-label="Provider calls"
        style={{
          position: "absolute",
          bottom: 0,
          left: 20,
          maxHeight: 105,
          overflow: "auto",
        }}
      >
        {events.join("\n") || "No provider calls"}
      </pre>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
