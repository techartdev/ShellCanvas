// SPDX-License-Identifier: MPL-2.0
import { parseAppPackage, type AppPackage } from "./package";
import { RpcError } from "./rpc";
import { readClientEnvironment } from "./client-platform";
import {
  clientCompatibilityReason,
  type ClientEnvironment,
} from "../../packages/app-sdk/src/client-platform";
import { catalogNotifications, holdCatalogLock } from "./catalog-coordination";
import {
  parseRepositorySource,
  type RepositorySource,
} from "../../packages/app-sdk/src/repository";

export interface InstalledApp {
  readonly source?: RepositorySource;
  readonly package: AppPackage;
  readonly generation: string;
  readonly grants: readonly string[];
  readonly enabled: boolean;
}
export interface CatalogSnapshot {
  readonly format: 1;
  readonly revision: string;
  readonly apps: readonly InstalledApp[];
}
export interface CatalogStorage {
  read(): Promise<unknown>;
  /** Hold a per-app shared running lease or exclusive removal lease. */
  hold?(id: string, mode: "shared" | "exclusive"): Promise<() => void>;
  /** Invalidation only: callers re-read and validate authoritative storage. */
  subscribe?(changed: () => void): () => void;
  /** Commit atomically only if storage still holds this revision. */
  compareAndSet(expected: string | null, next: CatalogSnapshot): Promise<void>;
}
export interface InstallReview {
  readonly source?: RepositorySource;
  readonly package: AppPackage;
  readonly digest: string;
  readonly replaces: InstalledApp | null;
}
const identity = /^[a-zA-Z0-9-]{1,100}$/;
function grantsFor(app: AppPackage, grants: readonly string[]) {
  if (
    new Set(grants).size !== grants.length ||
    grants.some((grant) => !app.permissions.includes(grant))
  )
    throw new RpcError(
      "invalid",
      "Approve only permissions declared by this package.",
    );
  return Object.freeze([...grants]);
}
export function parseCatalog(value: unknown): CatalogSnapshot | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value))
    throw new RpcError("invalid", "The saved app catalog is invalid.");
  const item = value as Record<string, unknown>;
  if (
    item.format !== 1 ||
    typeof item.revision !== "string" ||
    !identity.test(item.revision) ||
    !Array.isArray(item.apps)
  )
    throw new RpcError(
      "invalid",
      "The saved app catalog has an unsupported format.",
    );
  const ids = new Set<string>();
  const generations = new Set<string>();
  const apps = item.apps.map((raw: unknown): InstalledApp => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new RpcError("invalid", "Invalid installed app record.");
    const entry = raw as Record<string, unknown>;
    const app = parseAppPackage(JSON.stringify(entry.package));
    if (
      ids.has(app.id) ||
      typeof entry.generation !== "string" ||
      !identity.test(entry.generation) ||
      generations.has(entry.generation) ||
      typeof entry.enabled !== "boolean" ||
      !Array.isArray(entry.grants) ||
      entry.grants.some((grant) => typeof grant !== "string")
    )
      throw new RpcError(
        "invalid",
        "Invalid or duplicate installed app record.",
      );
    ids.add(app.id);
    generations.add(entry.generation);
    return Object.freeze({
      package: app,
      generation: entry.generation,
      grants: grantsFor(app, entry.grants as string[]),
      enabled: entry.enabled,
      ...(entry.source === undefined
        ? {}
        : { source: parseRepositorySource(entry.source) }),
    });
  });
  return Object.freeze({
    format: 1,
    revision: item.revision,
    apps: Object.freeze(apps),
  });
}

/** A running instance retains exactly the code and grants it launched with. */
export class AppLease {
  private stopped = false;
  private listeners = new Set<() => void>();
  constructor(
    readonly id: string,
    readonly installed: InstalledApp,
    private release: () => void,
    readonly client: ClientEnvironment = Object.freeze({ platform: "unknown" }),
  ) {}
  get closed() {
    return this.stopped;
  }
  onClose(listener: () => void) {
    if (this.stopped) {
      listener();
      return () => {};
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.release();
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* One consumer cannot prevent the rest from being revoked. */
      }
    }
    this.listeners.clear();
  }
}

/** The catalog persists installed versions, not live windows or secrets. */
export class AppCatalog {
  private state: CatalogSnapshot | null = null;
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private reviews = new WeakSet<InstallReview>();
  private leases = new Map<string, AppLease>();
  private listeners = new Set<() => void>();
  private empty: readonly InstalledApp[] = Object.freeze([]);
  private clientInfo: ClientEnvironment = Object.freeze({
    platform: "unknown",
  });
  constructor(
    private storage: CatalogStorage,
    private readClient = readClientEnvironment,
  ) {}
  get client() {
    return this.clientInfo;
  }
  compatibilityReason(app: AppPackage) {
    return clientCompatibilityReason(app, this.clientInfo);
  }
  private requireCompatible(app: AppPackage) {
    const reason = this.compatibilityReason(app);
    if (reason) throw new RpcError("unavailable", reason);
  }
  snapshot = () => this.state?.apps ?? this.empty;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Observers cannot undo a committed catalog. */
      }
    }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  load() {
    return this.serial(() => this.refresh());
  }
  private async refresh() {
    const client = await this.readClient();
    // A failed/corrupt read never replaces the previous state or writes an empty catalog.
    const next = parseCatalog(await this.storage.read());
    const clientChanged = this.clientInfo.platform !== client.platform;
    this.clientInfo = Object.freeze({ ...client });
    if (
      !this.loaded ||
      clientChanged ||
      next?.revision !== this.state?.revision
    ) {
      this.state = next;
      this.loaded = true;
      this.publish();
    }
  }
  watch(onError: (error: unknown) => void): () => void {
    let stopped = false;
    let requested = false;
    let running = false;
    const refresh = async () => {
      requested = true;
      if (running) return;
      running = true;
      try {
        while (requested && !stopped) {
          requested = false;
          try {
            await this.load();
          } catch (error) {
            if (!stopped) onError(error);
          }
        }
      } finally {
        running = false;
      }
    };
    const stop = this.storage.subscribe?.(() => {
      void refresh();
    });
    void refresh();
    return () => {
      stopped = true;
      stop?.();
    };
  }
  private check() {
    if (!this.loaded)
      throw new RpcError(
        "unavailable",
        "Load the installed app catalog first.",
      );
  }
  async review(raw: string, source?: RepositorySource): Promise<InstallReview> {
    this.check();
    const app = parseAppPackage(raw);
    const replaces =
      this.snapshot().find((entry) => entry.package.id === app.id) ?? null;
    const bytes = new TextEncoder().encode(JSON.stringify(app));
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const digest = [...new Uint8Array(hash)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (source) {
      source = parseRepositorySource(source);
      const rawHash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(raw),
      );
      const rawDigest = [...new Uint8Array(rawHash)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      if (rawDigest !== source.sha256)
        throw new RpcError(
          "invalid",
          "Repository fingerprint does not match this package.",
        );
    }
    const result = Object.freeze({
      package: app,
      digest,
      replaces,
      ...(source ? { source } : {}),
    });
    this.reviews.add(result);
    return result;
  }
  install(review: InstallReview, approved: readonly string[]) {
    const grants = grantsFor(review.package, approved);
    return this.serial(async () => {
      this.check();
      if (!this.reviews.has(review))
        throw new RpcError(
          "invalid",
          "Review this package before installing it.",
        );
      const current = this.snapshot().find(
        (entry) => entry.package.id === review.package.id,
      );
      if (
        (current?.generation ?? null) !==
          (review.replaces?.generation ?? null) ||
        current?.enabled !== review.replaces?.enabled
      )
        throw new RpcError(
          "invalid",
          "This app changed after review. Review the current update again.",
        );
      this.requireCompatible(review.package);
      const installed: InstalledApp = Object.freeze({
        package: review.package,
        generation: crypto.randomUUID(),
        grants,
        enabled: true,
        ...(review.source ? { source: review.source } : {}),
      });
      await this.commit([
        ...this.snapshot().filter(
          (entry) => entry.package.id !== installed.package.id,
        ),
        installed,
      ]);
      this.reviews.delete(review);
      return installed;
    });
  }
  private current(id: string, generation: string) {
    this.check();
    const current = this.snapshot().find((entry) => entry.package.id === id);
    if (!current || current.generation !== generation)
      throw new RpcError(
        "invalid",
        "The installed app changed. Refresh before continuing.",
      );
    return current;
  }
  setEnabled(id: string, generation: string, enabled: boolean) {
    return this.serial(async () => {
      const current = this.current(id, generation);
      if (enabled) this.requireCompatible(current.package);
      await this.commit(
        this.snapshot().map((entry) =>
          entry === current ? Object.freeze({ ...current, enabled }) : entry,
        ),
      );
    });
  }
  remove(id: string, generation: string) {
    return this.serial(async () => {
      this.current(id, generation);
      if (
        [...this.leases.values()].some(
          (lease) => lease.installed.package.id === id,
        )
      )
        throw new RpcError(
          "busy",
          "Close this app's running windows before removing it. Disable it to stop new launches while keeping those windows.",
        );
      const release = await this.storage.hold?.(id, "exclusive");
      try {
        await this.commit(
          this.snapshot().filter((entry) => entry.package.id !== id),
        );
      } finally {
        release?.();
      }
    });
  }
  private async commit(apps: readonly InstalledApp[]) {
    const next: CatalogSnapshot = Object.freeze({
      format: 1,
      revision: crypto.randomUUID(),
      apps: Object.freeze([...apps]),
    });
    await this.storage.compareAndSet(this.state?.revision ?? null, next);
    this.state = next;
    this.publish();
  }
  launch(id: string): Promise<AppLease> {
    return this.serial(async () => {
      this.check();
      const release = await this.storage.hold?.(id, "shared");
      try {
        // Read while holding the removal lock: stale launchers cannot resurrect
        // removed/disabled packages or silently launch an outdated generation.
        await this.refresh();
        const installed = this.snapshot().find(
          (entry) => entry.package.id === id,
        );
        if (!installed?.enabled)
          throw new RpcError(
            "unavailable",
            "This app is disabled or no longer installed.",
          );
        this.requireCompatible(installed.package);
        const identity = crypto.randomUUID();
        const lease = new AppLease(
          identity,
          installed,
          () => {
            this.leases.delete(identity);
            release?.();
          },
          this.clientInfo,
        );
        this.leases.set(identity, lease);
        return lease;
      } catch (error) {
        release?.();
        throw error;
      }
    });
  }
}

/** Browser and WebView persistence. IndexedDB transactions prevent concurrent lost updates. */
export function indexedCatalogStorage(
  name = "shellcanvas-runtime-apps",
): CatalogStorage {
  const notifications = catalogNotifications(name);
  let opening: Promise<IDBDatabase> | undefined;
  const database = () =>
    (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      let failed = false;
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("catalog");
      request.onerror = () => {
        failed = true;
        opening = undefined;
        reject(request.error);
      };
      request.onblocked = () => {
        failed = true;
        opening = undefined;
        reject(
          new RpcError(
            "busy",
            "Another desktop window is blocking the app catalog.",
          ),
        );
      };
      request.onsuccess = () => {
        const db = request.result;
        if (failed) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          opening = undefined;
        };
        resolve(db);
      };
    }));
  return {
    hold: (id, mode) => holdCatalogLock(name, id, mode),
    subscribe: notifications.subscribe,
    async read() {
      const db = await database();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction("catalog", "readonly");
        const request = transaction.objectStore("catalog").get("installed");
        transaction.oncomplete = () => resolve(request.result ?? null);
        transaction.onabort = () =>
          reject(
            transaction.error ??
              new RpcError("failed", "Unable to read installed apps."),
          );
      });
    },
    async compareAndSet(expected, next) {
      const db = await database();
      return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("catalog", "readwrite");
        const store = transaction.objectStore("catalog");
        let conflict = false;
        const request = store.get("installed");
        request.onsuccess = () => {
          const current = request.result;
          if (
            (current !== undefined &&
              (!current || typeof current.revision !== "string")) ||
            (current?.revision ?? null) !== expected
          ) {
            conflict = true;
            transaction.abort();
            return;
          }
          store.put(next, "installed");
        };
        transaction.oncomplete = () => {
          // Notification failure cannot turn a committed write into a failure.
          try {
            notifications.changed();
          } catch {
            /* Focus/polling will refresh. */
          }
          resolve();
        };
        transaction.onabort = () =>
          reject(
            conflict
              ? new RpcError(
                  "busy",
                  "Installed apps changed in another desktop window. Refresh the catalog and review again.",
                )
              : (transaction.error ??
                  new RpcError("failed", "Unable to save installed apps.")),
          );
      });
    },
  };
}
