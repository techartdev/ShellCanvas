// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from "react";
import { Activity, Copy, RefreshCw } from "lucide-react";
import type { AdapterServices } from "../adapters";
import {
  diagnosticLabels,
  type ConnectionDiagnostics,
} from "../adapter-diagnostics";
import { clipboard } from "../clipboard";
import "./AdapterDiagnosticsPanel.css";

export function AdapterDiagnosticsPanel({
  services,
}: {
  services: AdapterServices;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ConnectionDiagnostics[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const sequence = useRef(0);
  const copySequence = useRef(0);
  async function refresh() {
    copySequence.current++;
    const current = ++sequence.current;
    setBusy(true);
    setMessage("");
    try {
      const records = (await services.diagnostics?.()) ?? [];
      if (current !== sequence.current) return;
      setItems(records);
      setSelected((previous) =>
        records.some((item) => item.connection.instance === previous)
          ? previous
          : (records[0]?.connection.instance ?? null),
      );
    } catch {
      if (current === sequence.current)
        setMessage("Could not load connection diagnostics. Try refreshing.");
    } finally {
      if (current === sequence.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (open) void refresh();
    return () => {
      sequence.current++;
      copySequence.current++;
    };
  }, [open, services]);
  const record = items.find((item) => item.connection.instance === selected);
  async function copy() {
    if (!record) return;
    const current = ++copySequence.current;
    try {
      await clipboard.writeText(JSON.stringify(record, null, 2));
      if (current === copySequence.current)
        setMessage("Diagnostic report copied.");
    } catch {
      if (current === copySequence.current)
        setMessage("Could not copy the report. Try again.");
    }
  }
  if (!services.diagnostics) return null;
  return (
    <details
      className="adapter-diagnostics"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <Activity size={15} />
        Connection diagnostics
      </summary>
      {open && (
        <div className="adapter-diagnostics-body">
          <p className="adapter-diagnostics-note">
            Recent adapter connections in this window. Reports contain timing
            and outcomes, without configuration, file contents or terminal
            output.
          </p>
          <div className="adapter-diagnostics-controls">
            <label>
              Connection
              <select
                value={selected ?? ""}
                disabled={!items.length}
                onChange={(event) => {
                  copySequence.current++;
                  setSelected(Number(event.target.value));
                  setMessage("");
                }}
              >
                {!items.length && <option value="">No recent adapters</option>}
                {items.map((item) => (
                  <option
                    key={item.connection.instance}
                    value={item.connection.instance}
                  >
                    {item.connection.adapter} · connection{" "}
                    {item.connection.instance}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => void refresh()}
              aria-label="Refresh diagnostics"
            >
              <RefreshCw size={15} />
            </button>
            <button
              type="button"
              disabled={!record || busy}
              onClick={() => void copy()}
            >
              <Copy size={14} />
              Copy report
            </button>
          </div>
          {busy && <p role="status">Loading diagnostics…</p>}
          {!busy && !items.length && (
            <p>
              No adapter history yet. Connect an installed adapter to record its
              startup and activity.
            </p>
          )}
          {record && (
            <>
              <div className="adapter-diagnostics-overview">
                <strong>
                  {
                    {
                      preparing: "Preparing package",
                      starting: "Starting adapter",
                      connected: "Connected",
                      closed: "Closed",
                      failed: "Connection failed",
                    }[record.status]
                  }
                </strong>
                <span>
                  Attempt {record.attempt} · generation{" "}
                  {record.connection.generation}
                </span>
              </div>
              {record.discardedEvents > 0 && (
                <p className="adapter-diagnostics-note">
                  {record.discardedEvents} earlier events are outside the
                  retained history.
                </p>
              )}
              <div
                className="adapter-diagnostics-timeline"
                tabIndex={0}
                role="region"
                aria-label="Connection event history"
              >
                <table>
                  <thead>
                    <tr>
                      <th>Elapsed</th>
                      <th>Event</th>
                      <th>Request</th>
                      <th>Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {record.events.map((event) => (
                      <tr key={event.sequence}>
                        <td>{(event.elapsedMs / 1000).toFixed(3)}s</td>
                        <td>
                          {diagnosticLabels[event.kind] ?? "Adapter event"}
                        </td>
                        <td>{event.requestId ?? "—"}</td>
                        <td>{event.code ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <p className="adapter-diagnostics-note">
            Up to 256 events per connection and 32 recent connection histories
            are kept in memory for this app run. Refresh to see new events.
          </p>
          {message && <p role="status">{message}</p>}
        </div>
      )}
    </details>
  );
}
