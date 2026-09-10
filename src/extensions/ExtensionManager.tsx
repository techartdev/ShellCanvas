// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Github, Package, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { capabilityLabels, type Capability } from "../sdk";
import { AppCatalog, type AppLease, type InstallReview } from "./catalog";
import "./ExtensionManager.css";
import { inspectRepository } from "./repository";
import { clientPlatformLabels } from "../../packages/app-sdk/src/client-platform";

function permissionName(name: string) {
  if (name === "system.network")
    return "Send data to API endpoints you configure for this app";
  if (name === "system.console") return "Open and control remote consoles";
  if (name === "host.settings.read")
    return "Read settings provided by the remote device";
  if (name === "host.settings.write")
    return "Change settings on the remote device";
  if (name.startsWith("services."))
    return `Use ${name.slice(9)} services on the selected connection`;
  if (name === "system.storage") return "This app’s local data and settings";
  if (name === "system.clipboard.read")
    return "Read clipboard text, including content from other apps";
  if (name === "system.clipboard.write") return "Replace clipboard text";
  if (name === "system.clipboard.image.read")
    return "Read clipboard images, including content from other apps";
  if (name === "system.clipboard.image.write")
    return "Replace clipboard with an image";
  if (name === "system.clipboard.files.read")
    return "Read files and folders copied on this device for transfer";
  if (name === "system.clipboard.files.write")
    return "Replace the system clipboard with remote files and folders";
  return name === "system.dialogs"
    ? "Shared desktop dialogs"
    : (capabilityLabels[name as Capability] ?? name);
}
export function ExtensionManager({
  catalog,
  launch,
  sample,
  open,
}: {
  catalog: AppCatalog;
  launch?(lease: AppLease): void;
  open?(id: string): void;
  sample?: () => Promise<string>;
}) {
  const apps = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState<InstallReview | null>(null);
  const [grants, setGrants] = useState<readonly string[]>([]);
  const sequence = useRef(0);
  const file = useRef<HTMLInputElement>(null);
  const download = useRef<AbortController | null>(null);
  const [repositoryForm, setRepositoryForm] = useState(false);
  const [repository, setRepository] = useState("");
  const [reference, setReference] = useState("main");
  const [fetching, setFetching] = useState(false);
  const refresh = async () => {
    setLoading(true);
    try {
      await catalog.load();
      setError("");
    } catch (failure) {
      setError(String(failure));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
    return () => {
      sequence.current++;
      download.current?.abort();
    };
  }, [catalog]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const inspect = async (read: () => Promise<string>) => {
    const expected = ++sequence.current;
    await run(async () => {
      const next = await catalog.review(await read());
      if (sequence.current !== expected) return;
      setReview(next);
      setGrants(
        next.replaces
          ? next.replaces.grants.filter((grant) =>
              next.package.permissions.includes(grant),
            )
          : next.package.permissions,
      );
    });
  };
  const fromRepository = async (
    input = repository,
    ref = reference,
    expectedId?: string,
  ) => {
    const expected = ++sequence.current;
    download.current?.abort();
    const controller = new AbortController();
    download.current = controller;
    setFetching(true);
    setReview(null);
    await run(async () => {
      const result = await inspectRepository(input, ref, controller.signal);
      if (expectedId && result.manifest.id !== expectedId)
        throw new Error(
          "This repository now points to a different app. Its update was not installed.",
        );
      const next = await catalog.review(result.raw, result.source);
      if (controller.signal.aborted || sequence.current !== expected) return;
      setReview(next);
      setGrants(
        next.replaces
          ? next.replaces.grants.filter((grant) =>
              next.package.permissions.includes(grant),
            )
          : next.package.permissions,
      );
      setRepositoryForm(false);
    });
    if (sequence.current === expected) setFetching(false);
    if (download.current === controller) download.current = null;
  };
  return (
    <section className="extension-manager" aria-label="Installed apps">
      <header>
        <div>
          <p className="extension-eyebrow">YOUR WORKSPACE, EXTENDED</p>
          <h2>Apps</h2>
          <p>
            Add tools that make this desktop yours. Client:{" "}
            {clientPlatformLabels[catalog.client.platform]}.
          </p>
        </div>
        <div className="extension-actions">
          <button
            disabled={loading || busy}
            onClick={() => setRepositoryForm(!repositoryForm)}
          >
            <Github size={16} />
            Install from GitHub
          </button>
          <button
            onClick={() => void refresh()}
            disabled={loading || busy}
            aria-label="Refresh installed apps"
          >
            <RefreshCw size={16} />
          </button>
          <button
            onClick={() => file.current?.click()}
            disabled={loading || busy}
          >
            <Plus size={16} />
            Install package
          </button>
          {sample && (
            <button
              onClick={() => void inspect(sample)}
              disabled={loading || busy}
            >
              Review built sample
            </button>
          )}
          <input
            ref={file}
            type="file"
            accept=".json"
            aria-label="Select app package"
            hidden
            onChange={(event) => {
              const selected = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (selected)
                void inspect(async () => {
                  if (selected.size > 32 * 1024 * 1024)
                    throw new Error("This app package is too large.");
                  return selected.text();
                });
            }}
          />
        </div>
      </header>
      {repositoryForm && (
        <form
          className="extension-repository"
          onSubmit={(event) => {
            event.preventDefault();
            void fromRepository();
          }}
        >
          <div className="extension-review-heading">
            <Github size={22} />
            <div>
              <h3>A new tool, straight from its creator</h3>
              <p>
                Enter a repository with a ShellCanvas app manifest. You’ll
                review the app before installing.
              </p>
            </div>
          </div>
          <div className="extension-repository-fields">
            <label>
              GitHub repository
              <input
                autoFocus
                required
                placeholder="owner/repository"
                value={repository}
                disabled={busy}
                onChange={(event) => setRepository(event.target.value)}
              />
            </label>
            <label>
              Branch, tag or commit
              <input
                required
                value={reference}
                disabled={busy}
                onChange={(event) => setReference(event.target.value)}
              />
            </label>
          </div>
          <div className="extension-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => setRepositoryForm(false)}
            >
              Cancel
            </button>
            <button
              className="extension-primary"
              disabled={busy || loading}
              type="submit"
            >
              Review app
            </button>
          </div>
        </form>
      )}
      {fetching && (
        <div className="extension-repository-progress" role="status">
          <RefreshCw size={16} />
          <span>Fetching and checking the app package…</span>
          <div className="extension-actions">
            <button onClick={() => download.current?.abort()}>
              Cancel download
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="extension-error" role="alert">
          {error}
        </p>
      )}
      {review && (
        <section
          className="extension-review"
          aria-label="Review app installation"
        >
          <div className="extension-review-heading">
            <ShieldCheck size={22} />
            <div>
              <h3>
                {review.replaces ? "Update" : "Install"} {review.package.title}
              </h3>
              <p>
                {review.replaces ? `${review.replaces.package.version} → ` : ""}
                {review.package.version} · {review.package.id}
              </p>
            </div>
          </div>
          {review.source && (
            <p className="extension-source">
              From {review.source.owner}/{review.source.repository} ·{" "}
              {review.source.ref}
            </p>
          )}
          <p>
            Client support:{" "}
            {review.package.clientPlatforms
              ?.map((platform) => clientPlatformLabels[platform])
              .join(", ") ?? "No platform restriction declared"}
          </p>
          {catalog.compatibilityReason(review.package) && (
            <p className="extension-error" role="status">
              {catalog.compatibilityReason(review.package)}
            </p>
          )}
          {review.replaces?.source &&
            (!review.source ||
              review.replaces.source.owner !== review.source.owner ||
              review.replaces.source.repository !==
                review.source.repository) && (
              <p className="extension-error">
                The source differs from the installed version. Check that you
                trust this replacement.
              </p>
            )}
          <p>
            Approve the access this version can use. Existing windows keep their
            current version and permissions.
          </p>
          <fieldset disabled={busy}>
            <legend>App permissions</legend>
            {review.package.permissions.length ? (
              review.package.permissions.map((permission) => (
                <label key={permission}>
                  <input
                    type="checkbox"
                    checked={grants.includes(permission)}
                    onChange={(event) =>
                      setGrants(
                        event.target.checked
                          ? [...grants, permission]
                          : grants.filter((grant) => grant !== permission),
                      )
                    }
                  />
                  <span>
                    {permissionName(permission)}
                    {review.replaces &&
                      !review.replaces.grants.includes(permission) && (
                        <small>New access request</small>
                      )}
                  </span>
                </label>
              ))
            ) : (
              <p>No workspace permissions requested.</p>
            )}
          </fieldset>
          <details>
            <summary>Package fingerprint</summary>
            <code>{review.digest}</code>
            {review.source && (
              <>
                <p>Repository artifact SHA-256</p>
                <code>{review.source.sha256}</code>
              </>
            )}
            <p>
              This identifies the reviewed content; it does not verify its
              publisher.
            </p>
          </details>
          <div className="extension-actions">
            <button
              disabled={busy}
              onClick={() => {
                sequence.current++;
                setReview(null);
              }}
            >
              Cancel
            </button>
            <button
              className="extension-primary"
              disabled={busy || !!catalog.compatibilityReason(review.package)}
              onClick={() =>
                void run(async () => {
                  await catalog.install(review, grants);
                  setReview(null);
                })
              }
            >
              {busy
                ? "Saving…"
                : review.replaces
                  ? "Install update"
                  : "Install app"}
            </button>
          </div>
        </section>
      )}
      <div className="extension-list">
        {apps.map((entry) => (
          <article key={entry.package.id}>
            <div className="extension-icon">
              <Package size={22} />
            </div>
            <div className="extension-description">
              <h3>
                {entry.package.title}
                <span>
                  {catalog.compatibilityReason(entry.package)
                    ? "Incompatible"
                    : entry.enabled
                      ? "Ready"
                      : "Disabled"}
                </span>
              </h3>
              <p>
                Version {entry.package.version} · {entry.package.id}
              </p>
              <small>{entry.grants.length} approved permissions</small>
              {catalog.compatibilityReason(entry.package) && (
                <p>{catalog.compatibilityReason(entry.package)}</p>
              )}
              {entry.source && (
                <p>
                  {entry.source.owner}/{entry.source.repository} ·{" "}
                  {entry.source.ref}
                </p>
              )}
            </div>
            <div className="extension-actions">
              {entry.source && (
                <button
                  disabled={busy || loading}
                  onClick={() =>
                    void fromRepository(
                      `${entry.source!.owner}/${entry.source!.repository}`,
                      entry.source!.ref,
                      entry.package.id,
                    )
                  }
                >
                  Check update
                </button>
              )}
              <button
                disabled={
                  busy ||
                  loading ||
                  !entry.enabled ||
                  !!catalog.compatibilityReason(entry.package)
                }
                onClick={async () => {
                  let lease: AppLease | undefined;
                  try {
                    if (open) open(entry.package.id);
                    else if (launch) {
                      const opening = sequence.current;
                      lease = await catalog.launch(entry.package.id);
                      if (opening !== sequence.current) {
                        lease.close();
                        return;
                      }
                      launch(lease);
                    } else throw new Error("The desktop cannot open this app.");
                    setError("");
                  } catch (failure) {
                    lease?.close();
                    setError(String(failure));
                  }
                }}
              >
                Open app
              </button>
              <button
                disabled={
                  busy ||
                  loading ||
                  (!entry.enabled &&
                    !!catalog.compatibilityReason(entry.package))
                }
                onClick={() =>
                  void run(() =>
                    catalog.setEnabled(
                      entry.package.id,
                      entry.generation,
                      !entry.enabled,
                    ),
                  )
                }
              >
                {entry.enabled ? "Disable" : "Enable"}
              </button>
              <button
                disabled={busy || loading}
                onClick={() =>
                  void run(() =>
                    catalog.remove(entry.package.id, entry.generation),
                  )
                }
              >
                Remove
              </button>
            </div>
          </article>
        ))}
      </div>
      {!loading && !apps.length && (
        <div className="extension-empty">
          <Package size={30} />
          <h3>A place for your tools</h3>
          <p>Install a ShellCanvas app package to get started.</p>
        </div>
      )}
      <p className="extension-footnote">
        Disabling stops new launches. Close an app’s running windows before
        removing it. Removal retires access to that installation's local data.
      </p>
    </section>
  );
}
