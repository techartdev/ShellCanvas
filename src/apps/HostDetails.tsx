// SPDX-License-Identifier: MPL-2.0
import type { AppContext } from "../sdk";
import { capabilityLabels } from "../sdk";
import { useState } from "react";
import { RemoteSettings } from "../components/RemoteSettings";

export function HostDetails(context: AppContext) {
  const [tab, setTab] = useState<"overview" | "settings">("overview");
  const [settingsOpened, setSettingsOpened] = useState(false);
  return (
    <div className="host-details-shell">
      <nav className="host-details-tabs" aria-label="Host details sections">
        <button
          aria-pressed={tab === "overview"}
          onClick={() => setTab("overview")}
        >
          Overview
        </button>
        <button
          aria-pressed={tab === "settings"}
          onClick={() => {
            setSettingsOpened(true);
            setTab("settings");
          }}
        >
          Remote settings
        </button>
      </nav>
      <div className="host-details-content">
        <div hidden={tab !== "overview"}>
          <HostOverview {...context} />
        </div>
        <div hidden={tab !== "settings"}>
          <RemoteSettings {...context} enabled={settingsOpened} />
        </div>
      </div>
    </div>
  );
}

/** A small reference app: only consumes the provider's existing snapshot. */
function HostOverview({ session, preview, connected = true }: AppContext) {
  if (!session) return null;
  const { info } = session;
  return (
    <article className="host-details-app">
      <p className="eyebrow">
        {preview
          ? "SAMPLE HOST"
          : connected
            ? "CONNECTED HOST"
            : "LAST KNOWN HOST"}
      </p>
      <h2>{info.hostname}</h2>
      <p>
        Your host and the tools available in this workspace. System details
        reflect when this connection opened.
      </p>
      <dl>
        <div>
          <dt>System</dt>
          <dd>{info.system}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{info.provider}</dd>
        </div>
        <div>
          <dt>Home folder</dt>
          <dd>{info.home ?? "Not reported by this host"}</dd>
        </div>
      </dl>
      <p className="eyebrow">WORKSPACE TOOLS</p>
      <div className="capability-list">
        {info.capabilities.map((capability) => (
          <span key={capability}>
            {capabilityLabels[capability] ?? capability}
          </span>
        ))}
      </div>
      {info.capabilities.includes("terminal") && (
        <p>Terminal support is confirmed when a session opens.</p>
      )}
      {!info.capabilities.length && (
        <p>No workspace tools are available for this connection yet.</p>
      )}
      {info.notices.map((notice, index) => (
        <p key={index}>{notice}</p>
      ))}
    </article>
  );
}
