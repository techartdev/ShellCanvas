// SPDX-License-Identifier: MPL-2.0
import type { AppContext } from "../sdk";

/** A small reference app: only consumes the provider's existing snapshot. */
export function HostDetails({
  session,
  preview,
  connected = true,
}: AppContext) {
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
      <p>Your host and the tools available in this workspace.</p>
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
            {capability === "files.read"
              ? "File browsing"
              : capability === "terminal"
                ? "Terminal"
                : capability === "files.edit"
                  ? "Text editing"
                  : capability === "files.create"
                    ? "New text files"
                    : capability === "files.manage"
                      ? "File changes"
                      : capability}
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
