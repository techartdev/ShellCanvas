// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from "react";
import { Cable, Plus, RefreshCw, ShieldAlert, X } from "lucide-react";
import type { AdapterInfo, AdapterReview, AdapterServices } from "../adapters";
export function AdapterManager({ services }: { services: AdapterServices }) {
  const [items, setItems] = useState<AdapterInfo[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [review, setReview] = useState<AdapterReview | null>(null),
    [trusted, setTrusted] = useState(false),
    [removing, setRemoving] = useState<AdapterInfo | null>(null);
  const active = useRef(true),
    pending = useRef<string | null>(null);
  const sequence = useRef(0);
  async function refresh() {
    const expected = sequence.current;
    const items = await services.list();
    if (active.current && sequence.current === expected) setItems(items);
  }
  async function run(action: () => Promise<void>) {
    const expected = ++sequence.current;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      if (active.current && sequence.current === expected)
        setError(String(error));
    } finally {
      if (active.current && sequence.current === expected) setBusy(false);
    }
  }
  useEffect(() => {
    active.current = true;
    void run(refresh);
    return () => {
      active.current = false;
      sequence.current++;
      const id = pending.current;
      pending.current = null;
      if (id) void services.cancelReview(id).catch(() => {});
    };
  }, [services]);
  async function inspect() {
    const id = crypto.randomUUID();
    pending.current = id;
    setTrusted(false);
    await run(async () => {
      let result: AdapterReview | null;
      try {
        result = await services.review(id);
      } catch (error) {
        if (pending.current !== id) return;
        pending.current = null;
        throw error;
      }
      if (!active.current || pending.current !== id) {
        await services.cancelReview(id);
        return;
      }
      setReview(result);
      if (!result) pending.current = null;
    });
  }
  async function cancel() {
    const id = pending.current;
    pending.current = null;
    setReview(null);
    setTrusted(false);
    if (id) await services.cancelReview(id);
  }
  return (
    <section
      className="extension-manager"
      aria-label="Installed connection adapters"
    >
      <header>
        <div>
          <p className="extension-eyebrow">CONNECTIONS, YOUR WAY</p>
          <h2>Connection adapters</h2>
          <p>Add the protocols and devices you work with.</p>
        </div>
        <div className="extension-actions">
          <button
            disabled={busy}
            onClick={() => void run(refresh)}
            aria-label="Refresh adapters"
          >
            <RefreshCw size={16} />
          </button>
          <button disabled={busy || !!review} onClick={() => void inspect()}>
            <Plus size={16} />
            Install adapter
          </button>
        </div>
      </header>
      {error && (
        <p className="extension-error" role="alert">
          {error}
        </p>
      )}
      {busy && !review && (
        <p role="status">
          Preparing adapters…
          {pending.current && (
            <button
              className="icon-button"
              aria-label="Cancel adapter review"
              onClick={() => void run(cancel)}
            >
              <X size={14} />
            </button>
          )}
        </p>
      )}
      {review && (
        <div
          className="extension-review"
          role="region"
          aria-label="Review native adapter"
        >
          <div className="extension-review-heading">
            <div>
              <p className="extension-eyebrow">
                {review.replaces ? "REVIEW UPDATE" : "REVIEW INSTALLATION"}
              </p>
              <h3>
                {review.package.name} <small>{review.package.version}</small>
              </h3>
            </div>
            <ShieldAlert size={23} />
          </div>
          <p>{review.package.description}</p>
          <p>
            <code>{review.package.id}</code> · {review.package.platform} ·{" "}
            {(review.package.bytes / 1024 / 1024).toFixed(1)} MB
          </p>
          <p>
            This adapter runs native code with your account’s permissions,
            including access to local files and the network. Install it only if
            you trust its source.
          </p>
          <label className="adapter-trust">
            <input
              type="checkbox"
              checked={trusted}
              disabled={busy}
              onChange={(event) => setTrusted(event.target.checked)}
            />
            I trust the source of this adapter.
          </label>
          <div className="extension-actions">
            <button disabled={busy} onClick={() => void run(cancel)}>
              Cancel
            </button>
            <button
              disabled={busy || !trusted}
              onClick={() =>
                void run(async () => {
                  const id = review.requestId;
                  pending.current = null;
                  setReview(null);
                  await services.install(id);
                  await refresh();
                })
              }
            >
              {review.replaces ? "Update adapter" : "Install trusted adapter"}
            </button>
          </div>
        </div>
      )}
      {removing && (
        <div
          className="extension-review"
          role="region"
          aria-label="Remove adapter"
        >
          <h3>Remove {removing.name}?</h3>
          <p>
            Existing connections keep their current version. New connections
            will need the adapter installed again.
          </p>
          <div className="extension-actions">
            <button disabled={busy} onClick={() => setRemoving(null)}>
              Keep adapter
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await services.remove(removing.id, removing.revision);
                  setRemoving(null);
                  await refresh();
                })
              }
            >
              Remove adapter
            </button>
          </div>
        </div>
      )}
      <div className="extension-list">
        {items.map((item) => (
          <article className="extension-card" key={item.id}>
            <div className="extension-review-heading">
              <div>
                <h3>
                  <Cable size={17} /> {item.name}
                </h3>
                <p>{item.description}</p>
                <p>
                  {item.version} ·{" "}
                  {item.enabled ? "Ready for new connections" : "Disabled"}
                </p>
              </div>
            </div>
            <div className="extension-actions">
              <button
                disabled={busy || !!review}
                onClick={() =>
                  void run(async () => {
                    await services.setEnabled(
                      item.id,
                      item.revision,
                      !item.enabled,
                    );
                    await refresh();
                  })
                }
              >
                {item.enabled ? "Disable" : "Enable"}
              </button>
              <button
                disabled={busy || !!review}
                onClick={() => setRemoving(item)}
              >
                Remove
              </button>
            </div>
          </article>
        ))}
      </div>
      {!busy && !items.length && (
        <div className="extension-empty">
          <Cable size={30} />
          <h3>A connection for every device</h3>
          <p>
            Install an adapter manifest, then choose connection adapters when
            adding a workspace.
          </p>
        </div>
      )}
      <p className="extension-footnote">
        Updates and disabling apply to new connections. Running connections keep
        their installed version.
      </p>
    </section>
  );
}
