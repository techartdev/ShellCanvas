// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ArrowLeft,
  FileUp,
  Github,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { capabilityLabels, type Capability } from "../sdk";
import {
  AppCatalog,
  type AppLease,
  type InstallReview,
  type InstalledApp,
} from "./catalog";
import "./ExtensionManager.css";
import "./AppManager.css";
import { inspectRepository } from "./repository";
import { clientPlatformLabels } from "../../packages/app-sdk/src/client-platform";
import { AppIcon } from "../components/AppIcon";
import { appSummary, byTitle, matchesSearch } from "./app-listing";

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

export type ManagerPage = "installed" | "add";
export const managerPages: readonly (readonly [ManagerPage, string])[] = [
  ["installed", "Installed"],
  ["add", "Add apps"],
];

export function ManagerTabs<T extends string>({
  tabs,
  current,
  select,
}: {
  tabs: readonly (readonly [T, string])[];
  current: T;
  select(tab: T): void;
}) {
  return (
    <nav className="app-manager-tabs" aria-label="App Manager sections">
      {tabs.map(([id, label]) => (
        <button
          key={id}
          aria-pressed={current === id}
          onClick={() => select(id)}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

function platforms(app: InstalledApp["package"]) {
  return (
    app.clientPlatforms
      ?.map((platform) => clientPlatformLabels[platform])
      .join(", ") ?? "Any ShellCanvas client"
  );
}

/**
 * Installed apps, their details and manual installation. `page` and `visit`
 * let a parent own the section tabs; without them this renders its own.
 */
export function ExtensionManager({
  catalog,
  launch,
  sample,
  open,
  page,
  navigate,
  visit = 0,
}: {
  catalog: AppCatalog;
  launch?(lease: AppLease): void;
  open?(id: string): void;
  sample?: () => Promise<string>;
  page?: ManagerPage;
  navigate?(page: ManagerPage): void;
  /** Changes whenever the parent's tab is chosen, returning to that section's start. */
  visit?: number;
}) {
  const apps = useSyncExternalStore(catalog.subscribe, catalog.snapshot);
  const [ownPage, setOwnPage] = useState<ManagerPage>("installed");
  const current = page ?? ownPage;
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState<InstallReview | null>(null);
  const [grants, setGrants] = useState<readonly string[]>([]);
  const sequence = useRef(0);
  const file = useRef<HTMLInputElement>(null);
  const download = useRef<AbortController | null>(null);
  const [repository, setRepository] = useState("");
  const [reference, setReference] = useState("main");
  const [fetching, setFetching] = useState(false);
  const show = (next: ManagerPage) => (navigate ?? setOwnPage)(next);
  const leave = () => {
    setSelected(null);
    setRemoving(null);
    setReview(null);
    setError("");
  };
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
  useEffect(leave, [visit]);
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
  const reviewing = (next: InstallReview) => {
    setReview(next);
    setGrants(
      next.replaces
        ? next.replaces.grants.filter((grant) =>
            next.package.permissions.includes(grant),
          )
        : next.package.permissions,
    );
  };
  const inspect = async (read: () => Promise<string>) => {
    const expected = ++sequence.current;
    await run(async () => {
      const next = await catalog.review(await read());
      if (sequence.current !== expected) return;
      reviewing(next);
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
      const next = await catalog.review(
        result.raw,
        result.source,
        result.manifest.description,
      );
      if (controller.signal.aborted || sequence.current !== expected) return;
      reviewing(next);
    });
    if (sequence.current === expected) setFetching(false);
    if (download.current === controller) download.current = null;
  };
  const openEntry = async (entry: InstalledApp) => {
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
  };
  const status = (entry: InstalledApp) =>
    catalog.compatibilityReason(entry.package)
      ? "Incompatible"
      : entry.enabled
        ? undefined
        : "Disabled";
  const canOpen = (entry: InstalledApp) =>
    !busy &&
    !loading &&
    entry.enabled &&
    !catalog.compatibilityReason(entry.package);
  const entry = selected
    ? apps.find((item) => item.package.id === selected)
    : undefined;
  const listed = byTitle(apps).filter((item) =>
    matchesSearch(query, [
      item.package.title,
      appSummary(item),
      item.package.id,
      item.source && `${item.source.owner}/${item.source.repository}`,
    ]),
  );

  const reviewPage = review && (
    <section
      className="extension-review app-review"
      aria-label="Review app installation"
    >
      <div className="app-hero">
        <AppIcon
          id={review.package.id}
          image={review.package.icon}
          size="hero"
        />
        <div className="app-hero-text">
          <p className="extension-eyebrow app-review-kind">
            <ShieldCheck size={13} />
            {review.replaces ? "REVIEW UPDATE" : "REVIEW NEW APP"}
          </p>
          <h3>
            {review.replaces ? "Update" : "Install"} {review.package.title}
          </h3>
          <p className="app-hero-summary">
            {review.package.description ??
              review.listing ??
              "This package has no description."}
          </p>
          <p className="app-review-version">
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
      <p>Client support: {platforms(review.package)}</p>
      {catalog.compatibilityReason(review.package) && (
        <p className="extension-error" role="status">
          {catalog.compatibilityReason(review.package)}
        </p>
      )}
      {review.replaces?.source &&
        (!review.source ||
          review.replaces.source.owner !== review.source.owner ||
          review.replaces.source.repository !== review.source.repository) && (
          <p className="extension-error">
            The source differs from the installed version. Check that you trust
            this replacement.
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
              const installed = await catalog.install(review, grants);
              setReview(null);
              setQuery("");
              setSelected(installed.package.id);
              show("installed");
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
  );

  const detailsPage = entry && (
    <section
      className="app-details"
      aria-label={`${entry.package.title} details`}
    >
      <button className="app-back" onClick={() => leave()}>
        <ArrowLeft size={15} />
        Installed apps
      </button>
      <div className="app-hero">
        <AppIcon id={entry.package.id} image={entry.package.icon} size="hero" />
        <div className="app-hero-text">
          <h3>{entry.package.title}</h3>
          <p className="app-hero-summary">{appSummary(entry)}</p>
          <div className="extension-actions">
            <button
              className="extension-primary app-open-wide"
              disabled={!canOpen(entry)}
              onClick={() => void openEntry(entry)}
            >
              Open
            </button>
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
                Check for update
              </button>
            )}
            <button
              disabled={
                busy ||
                loading ||
                (!entry.enabled && !!catalog.compatibilityReason(entry.package))
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
              className="app-danger"
              disabled={busy || loading}
              onClick={() => setRemoving(entry.package.id)}
            >
              Remove
            </button>
          </div>
        </div>
      </div>
      {removing === entry.package.id && (
        <div className="app-confirm" role="group" aria-label="Confirm removal">
          <p>
            Remove {entry.package.title}? Close its windows first. Removal
            retires access to this installation’s local data.
          </p>
          <div className="extension-actions">
            <button disabled={busy} onClick={() => setRemoving(null)}>
              Keep app
            </button>
            <button
              className="app-danger-solid"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  try {
                    await catalog.remove(entry.package.id, entry.generation);
                    setSelected(null);
                  } finally {
                    setRemoving(null);
                  }
                })
              }
            >
              Remove app
            </button>
          </div>
        </div>
      )}
      {catalog.compatibilityReason(entry.package) && (
        <p className="extension-error" role="status">
          {catalog.compatibilityReason(entry.package)}
        </p>
      )}
      <dl className="app-facts">
        <div>
          <dt>Status</dt>
          <dd>
            {status(entry) === "Disabled"
              ? "Disabled · open windows keep running"
              : (status(entry) ?? "Ready")}
          </dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{entry.package.version}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>
            {entry.source
              ? `GitHub · ${entry.source.owner}/${entry.source.repository} · ${entry.source.ref}`
              : "App package file"}
          </dd>
        </div>
        <div>
          <dt>Client support</dt>
          <dd>{platforms(entry.package)}</dd>
        </div>
        <div className="app-fact-wide">
          <dt>Identifier</dt>
          <dd>{entry.package.id}</dd>
        </div>
      </dl>
      <section className="app-access" aria-label="App permissions">
        <h4>Access</h4>
        {entry.package.permissions.length ? (
          <ul>
            {entry.package.permissions.map((permission) => (
              <li
                key={permission}
                className={
                  entry.grants.includes(permission) ? undefined : "declined"
                }
              >
                <span>{permissionName(permission)}</span>
                <small>
                  {entry.grants.includes(permission)
                    ? "Approved"
                    : "Not approved"}
                </small>
              </li>
            ))}
          </ul>
        ) : (
          <p>No workspace permissions requested.</p>
        )}
        <p className="extension-footnote">
          Access changes take effect when you install an update. Disabling stops
          new launches; removal requires this app’s windows to be closed.
        </p>
      </section>
    </section>
  );

  const installedPage = (
    <>
      <div className="app-toolbar">
        <label className="app-search">
          <Search size={15} />
          <input
            type="search"
            value={query}
            placeholder="Search installed apps"
            aria-label="Search installed apps"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="extension-actions">
          <button
            onClick={() => void refresh()}
            disabled={loading || busy}
            aria-label="Refresh installed apps"
            title="Refresh installed apps"
          >
            <RefreshCw size={16} />
          </button>
          <button className="extension-primary" onClick={() => show("add")}>
            <Plus size={16} />
            Add app
          </button>
        </div>
      </div>
      {!!apps.length && (
        <h3 className="app-section-title">
          Installed apps <span>{apps.length}</span>
        </h3>
      )}
      <div className="app-grid">
        {listed.map((item) => {
          const label = status(item);
          return (
            <article
              key={item.package.id}
              className={`app-tile${label ? " inactive" : ""}`}
            >
              <button
                className="app-tile-main"
                title={`Show ${item.package.title} details`}
                onClick={() => {
                  setRemoving(null);
                  setSelected(item.package.id);
                }}
              >
                <AppIcon
                  id={item.package.id}
                  image={item.package.icon}
                  size="tile"
                />
                <span className="app-tile-text">
                  <strong>{item.package.title}</strong>
                  <span>{appSummary(item)}</span>
                </span>
              </button>
              <div className="app-tile-footer">
                <span className="app-tile-meta">
                  {label && (
                    <span
                      className={`app-badge${label === "Incompatible" ? " warning" : ""}`}
                    >
                      {label}
                    </span>
                  )}
                  <span>
                    Version {item.package.version}
                    {item.source ? " · GitHub" : ""}
                  </span>
                </span>
                <button
                  className="app-open"
                  disabled={!canOpen(item)}
                  onClick={() => void openEntry(item)}
                >
                  Open
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {loading && !apps.length && (
        <p className="app-quiet" role="status">
          Loading installed apps…
        </p>
      )}
      {!loading && !apps.length && (
        <div className="extension-empty app-empty-state">
          <AppIcon id="installed-app" size="tile" />
          <h3>No apps installed yet</h3>
          <p>Add an app from GitHub or from an app package file.</p>
          <div className="extension-actions">
            <button className="extension-primary" onClick={() => show("add")}>
              <Plus size={16} />
              Add app
            </button>
          </div>
        </div>
      )}
      {!!apps.length && !listed.length && (
        <p className="app-quiet" role="status">
          No installed apps match “{query.trim()}”.
        </p>
      )}
    </>
  );

  const addPage = (
    <div className="app-add">
      <div className="app-add-intro">
        <h3>Add apps</h3>
        <p>
          Apps come directly from their creators. Before anything is installed,
          you review the app, its version and the access it asks for.
        </p>
      </div>
      <div className="app-sources">
        <form
          className="app-source"
          onSubmit={(event) => {
            event.preventDefault();
            void fromRepository();
          }}
        >
          <span className="app-source-icon">
            <Github size={20} />
          </span>
          <h4>From GitHub</h4>
          <p>A public repository that publishes a ShellCanvas app.</p>
          <div className="extension-repository-fields">
            <label>
              GitHub repository
              <input
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
              className="extension-primary"
              disabled={busy || loading}
              type="submit"
            >
              Review app
            </button>
          </div>
        </form>
        <div className="app-source">
          <span className="app-source-icon">
            <FileUp size={20} />
          </span>
          <h4>From an app package</h4>
          <p>
            A <code>.shellcanvas.json</code> file built with the ShellCanvas app
            SDK.
          </p>
          <div className="extension-actions">
            <button
              className="extension-primary"
              onClick={() => file.current?.click()}
              disabled={loading || busy}
            >
              Choose package…
            </button>
            {sample && (
              <button
                onClick={() => void inspect(sample)}
                disabled={loading || busy}
              >
                Review built sample
              </button>
            )}
          </div>
        </div>
      </div>
      <p className="extension-footnote">
        This desktop is a {clientPlatformLabels[catalog.client.platform]}{" "}
        client. A package fingerprint identifies reviewed content; it does not
        verify the publisher.
      </p>
    </div>
  );

  return (
    <section className="extension-manager app-manager-page" aria-label="Apps">
      {!navigate && (
        <ManagerTabs
          tabs={managerPages}
          current={current}
          select={(tab) => {
            leave();
            setOwnPage(tab);
          }}
        />
      )}
      <input
        ref={file}
        type="file"
        accept=".json"
        aria-label="Select app package"
        hidden
        onChange={(event) => {
          const selectedFile = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (selectedFile)
            void inspect(async () => {
              if (selectedFile.size > 32 * 1024 * 1024)
                throw new Error("This app package is too large.");
              return selectedFile.text();
            });
        }}
      />
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
      {reviewPage ??
        (current === "add" ? addPage : (detailsPage ?? installedPage))}
    </section>
  );
}
