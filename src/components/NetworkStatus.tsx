// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Network, Unplug, X } from "lucide-react";
import {
  networkAvailable,
  subscribeNetworkAvailability,
} from "../network-availability";
import "./NetworkStatus.css";

export function NetworkStatus({
  hostName,
  connected,
  preview = false,
}: {
  hostName?: string;
  connected: boolean;
  preview?: boolean;
}) {
  const online = useSyncExternalStore(
    subscribeNetworkAvailability,
    networkAvailable,
    () => true,
  );
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const summary = online ? "Network detected" : "No network detected";
  const hostStatus = hostName
    ? connected
      ? "Connected"
      : "Disconnected"
    : "No host connected";
  return (
    <div className="network-status" ref={root}>
      <button
        ref={button}
        className={`network-status-button ${online ? "" : "offline"}`}
        aria-label={`Network status: ${summary}. ${hostStatus}`}
        title={`${summary} · ${hostStatus}`}
        aria-expanded={open}
        aria-controls="network-status-panel"
        onClick={() => setOpen(!open)}
      >
        {online ? <Network size={16} /> : <Unplug size={16} />}
      </button>
      {open && (
        <section
          id="network-status-panel"
          className="network-status-panel"
          aria-label="Network status"
        >
          <div className="network-status-heading">
            <strong>Network status</strong>
            <button
              aria-label="Close network status"
              onClick={() => {
                setOpen(false);
                button.current?.focus();
              }}
            >
              <X size={16} />
            </button>
          </div>
          <dl>
            <dt>This PC</dt>
            <dd>{summary}</dd>
            <dt>{preview ? "Sample host" : "Current host"}</dt>
            <dd>
              {hostName && (
                <span className="network-host-name">{hostName}</span>
              )}
              <span>{hostStatus}</span>
            </dd>
          </dl>
          <p>
            Network availability is reported by this PC. It does not confirm
            Internet access or Wi-Fi signal strength.
          </p>
          {preview && <p>Host status uses sample data in design preview.</p>}
        </section>
      )}
    </div>
  );
}
