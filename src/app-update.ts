// SPDX-License-Identifier: MPL-2.0
import { Channel, invoke } from "@tauri-apps/api/core";

export type UpdateRelease = {
  version: string;
  currentVersion: string;
  notes: string;
};
export type UpdateProgress = { downloaded: number; total?: number | null };
export type UpdateState = {
  stage:
    | "idle"
    | "checking"
    | "available"
    | "current"
    | "downloading"
    | "installing";
  release?: UpdateRelease;
  progress?: UpdateProgress;
  error?: string;
  checkedAt?: number;
};
export interface UpdateService {
  check(): Promise<UpdateRelease | null>;
  download(
    version: string,
    progress: (value: UpdateProgress) => void,
  ): Promise<void>;
  install(version: string): Promise<void>;
  cancel(): Promise<void>;
}
export const nativeUpdates: UpdateService = {
  check: () => invoke("check_app_update"),
  download: (version, progress) => {
    const channel = new Channel<UpdateProgress>();
    channel.onmessage = progress;
    return invoke("download_app_update", { version, progress: channel });
  },
  install: (version) => invoke("install_app_update", { version }),
  cancel: () => invoke("cancel_app_update"),
};

export class UpdateController {
  private state: UpdateState = { stage: "idle" };
  private listeners = new Set<() => void>();
  private generation = 0;
  private busy = false;
  private canceling = false;
  constructor(private service: UpdateService) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(state: UpdateState) {
    this.state = { checkedAt: this.state.checkedAt, ...state };
    this.listeners.forEach((listener) => listener());
  }
  async check() {
    if (this.busy) return;
    this.busy = true;
    const generation = ++this.generation;
    const previousRelease = this.state.release;
    this.set({
      stage: "checking",
      release: previousRelease,
      checkedAt: Date.now(),
    });
    try {
      const release = await this.service.check();
      if (generation === this.generation)
        this.set(
          release ? { stage: "available", release } : { stage: "current" },
        );
    } catch (error) {
      if (generation === this.generation)
        this.set({
          stage: previousRelease ? "available" : "idle",
          release: previousRelease,
          error: String(error),
        });
    } finally {
      if (generation === this.generation) this.busy = false;
    }
  }
  async apply(blocker: () => string | undefined) {
    const release = this.state.release;
    if (this.busy || !release) return;
    const blocked = blocker();
    if (blocked) {
      this.set({ stage: "available", release, error: blocked });
      return;
    }
    this.busy = true;
    const generation = ++this.generation;
    this.set({ stage: "downloading", release });
    try {
      await this.service.download(release.version, (progress) => {
        if (generation === this.generation)
          this.set({ stage: "downloading", release, progress });
      });
      if (generation !== this.generation) return;
      const blockedAfterDownload = blocker();
      if (blockedAfterDownload) throw new Error(blockedAfterDownload);
      this.set({ stage: "installing", release });
      await this.service.install(release.version);
    } catch (error) {
      if (generation === this.generation)
        this.set({ stage: "available", release, error: String(error) });
    } finally {
      if (generation === this.generation) this.busy = false;
    }
  }
  async cancel() {
    if (this.state.stage !== "downloading" || this.canceling) return;
    this.canceling = true;
    ++this.generation;
    const release = this.state.release;
    // Keep the controller busy until native cancellation has been acknowledged.
    let error: string | undefined;
    try {
      await this.service.cancel();
    } catch (cause) {
      error = `Could not cancel the native download: ${String(cause)}. It will not be installed.`;
    } finally {
      this.canceling = false;
      this.busy = false;
      this.set({ stage: "available", release, error });
    }
  }
}

export const UPDATE_CHECK_INTERVAL = 30 * 60 * 1000;
export const UPDATE_RETRY_INTERVAL = 5 * 60 * 1000;

/** Check at startup, while the app stays open, and after sleep/network recovery. */
export function startAutomaticUpdateChecks(controller: UpdateController) {
  const check = (networkRecovered = false) => {
    // The webview's online flag is only a hint (VPNs can report false).
    // Let the native updater determine whether the release server is reachable.
    const state = controller.snapshot();
    const interval = state.error
      ? networkRecovered
        ? 60_000
        : UPDATE_RETRY_INTERVAL
      : UPDATE_CHECK_INTERVAL;
    if (
      state.checkedAt === undefined ||
      Date.now() - state.checkedAt >= interval
    )
      void controller.check();
  };
  const resume = () => check();
  const online = () => check(true);
  const visible = () => {
    if (document.visibilityState === "visible") check();
  };
  check();
  const timer = window.setInterval(resume, 60_000);
  window.addEventListener("focus", resume);
  window.addEventListener("online", online);
  document.addEventListener("visibilitychange", visible);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("focus", resume);
    window.removeEventListener("online", online);
    document.removeEventListener("visibilitychange", visible);
  };
}

export function updateBlocker(
  dirty: boolean,
  busy: boolean,
): string | undefined {
  if (dirty)
    return "Save or close unsaved documents in every workspace before updating.";
  if (busy)
    return "Finish or stop running app tasks and file transfers before updating.";
}
