// SPDX-License-Identifier: MPL-2.0
import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  LockKeyhole,
  RefreshCw,
  Settings2,
} from "lucide-react";
import type { AppContext, HostSetting } from "../sdk";
import "./RemoteSettings.css";

export function RemoteSettings({
  services,
  session,
  connected = true,
  enabled,
  setDocumentState,
}: AppContext & { enabled: boolean }) {
  const [fields, setFields] = useState<HostSetting[]>([]);
  const formId = useId();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [review, setReview] = useState<{
    field: HostSetting;
    value: string;
  } | null>(null);
  const generation = useRef(0);
  const supported = !!session?.info.capabilities.includes("host.settings");
  const dirty = Object.entries(drafts).some(
    ([id, value]) =>
      value !== (fields.find((field) => field.id === id)?.value ?? ""),
  );
  useEffect(() => {
    setDocumentState?.({ dirty, busy: working });
  }, [dirty, working]);
  async function refresh() {
    if (!supported || !connected || working) return;
    const request = ++generation.current;
    setLoading(true);
    setError("");
    setReview(null);
    setNotice("");
    try {
      const result = await services.readHostSettings();
      if (request !== generation.current) return;
      setFields((old) => [
        ...result,
        ...old
          .filter((field) => !result.some((item) => item.id === field.id))
          .map((field) => ({
            ...field,
            writable: false,
            revision: null,
            reason: "This setting is no longer available from the provider.",
          })),
      ]);
      setNeedsRefresh(false);
    } catch (error) {
      if (request === generation.current) {
        setError(String(error));
        setNeedsRefresh(true);
      }
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (enabled && connected && supported) void refresh();
    else {
      ++generation.current;
      setLoading(false);
      setReview(null);
    }
    return () => {
      ++generation.current;
    };
  }, [services, connected, supported, enabled]);
  async function apply() {
    if (!review?.field.revision || working || !connected || needsRefresh)
      return;
    const request = generation.current;
    const current = review;
    const revision = review.field.revision;
    setWorking(true);
    setError("");
    setNotice("");
    try {
      const result = await services.applyHostSetting(
        current.field.id,
        current.value,
        revision,
      );
      if (request !== generation.current) return;
      setFields((old) =>
        old.map((field) => (field.id === result.id ? result : field)),
      );
      setDrafts((old) => {
        const next = { ...old };
        delete next[result.id];
        return next;
      });
      setReview(null);
      setNotice(`${result.label} updated and verified on the host.`);
    } catch (error) {
      if (request === generation.current) {
        setError(String(error));
        setNeedsRefresh(true);
        setReview(null);
      }
    } finally {
      setWorking(false);
    }
  }
  return (
    <section className="remote-settings" aria-label="Remote host settings">
      <header>
        <div>
          <p className="eyebrow">ON THIS HOST</p>
          <h2>Remote settings</h2>
        </div>
        <button
          className="remote-refresh"
          disabled={!connected || !supported || loading || working}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} className={loading ? "spin" : ""} /> Refresh
          settings
        </button>
      </header>
      <p>
        Changes here apply to <strong>{session?.info.hostname}</strong>. Review
        each change before applying it.
      </p>
      {!supported && (
        <p className="remote-settings-note">
          <LockKeyhole size={16} /> This device provider does not offer remote
          settings yet. Its other available tools remain usable.
        </p>
      )}
      {!connected && (
        <p className="remote-settings-note">
          Reconnect this host to refresh or apply settings. Your proposed values
          are preserved.
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {needsRefresh && (
        <p className="remote-settings-note">
          Refresh the host's values before reviewing another change. Your
          proposed values will be kept.
        </p>
      )}
      {notice && (
        <p className="remote-settings-success" role="status">
          <Check size={15} />
          {notice}
        </p>
      )}
      {loading && !fields.length && (
        <p role="status">Reading supported settings…</p>
      )}
      {!loading && supported && connected && !fields.length && !error && (
        <p>No settings are currently exposed by this provider.</p>
      )}
      <div className="remote-settings-fields">
        {fields.map((field) => {
          const controlId = `${formId}-${field.id}`;
          const value = drafts[field.id] ?? field.value ?? "";
          const changed = value !== (field.value ?? "");
          const editable =
            connected &&
            supported &&
            field.writable &&
            !!field.revision &&
            !working &&
            !loading;
          const reviewing = review?.field.id === field.id;
          return (
            <div className="remote-setting-card" key={field.id}>
              <label htmlFor={controlId}>
                <Settings2 size={16} />
                {field.label}
                {!field.writable && (
                  <span>
                    <LockKeyhole size={12} />{" "}
                    {field.value === null ? "Unavailable" : "Read only"}
                  </span>
                )}
              </label>
              <p>{field.description}</p>
              <div className="remote-setting-control">
                {field.editor === "select" ? (
                  <select
                    id={controlId}
                    value={value}
                    disabled={!editable}
                    onChange={(event) => {
                      setDrafts({ ...drafts, [field.id]: event.target.value });
                      setReview(null);
                      setNotice("");
                    }}
                  >
                    {!field.choices.includes(value) && (
                      <option value={value}>{value || "Unavailable"}</option>
                    )}
                    {field.choices.map((choice) => (
                      <option key={choice} value={choice}>
                        {choice}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    id={controlId}
                    value={value}
                    placeholder={
                      field.value === null ? "Unavailable" : "Not configured"
                    }
                    readOnly={!editable}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => {
                      setDrafts({ ...drafts, [field.id]: event.target.value });
                      setReview(null);
                      setNotice("");
                    }}
                  />
                )}
                {changed && (
                  <button
                    disabled={working}
                    onClick={() => {
                      setDrafts((old) => {
                        const next = { ...old };
                        delete next[field.id];
                        return next;
                      });
                      setReview(null);
                    }}
                  >
                    Reset draft
                  </button>
                )}
                <button
                  className="remote-review"
                  disabled={!editable || !changed || needsRefresh || !value}
                  onClick={() => setReview({ field, value })}
                >
                  Review change <ArrowRight size={13} />
                </button>
              </div>
              {field.reason && (
                <p className="remote-setting-reason">{field.reason}</p>
              )}
              {reviewing && (
                <div
                  className="remote-setting-review"
                  role="region"
                  aria-label={`Review ${field.label}`}
                >
                  <strong>
                    {field.label} on {session?.info.hostname}
                  </strong>
                  <div className="remote-setting-diff">
                    <div>
                      <small>Current</small>
                      <code>{review.field.value || "Not configured"}</code>
                    </div>
                    <ArrowRight size={16} />
                    <div>
                      <small>Proposed</small>
                      <code>{review.value}</code>
                    </div>
                  </div>
                  <div className="remote-setting-confirm">
                    <button disabled={working} onClick={() => setReview(null)}>
                      Keep editing
                    </button>
                    <button
                      disabled={working || !editable || needsRefresh}
                      onClick={() => void apply()}
                    >
                      {working ? "Applying…" : "Apply to host"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
