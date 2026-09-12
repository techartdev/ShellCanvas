// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ArrowDownToLine, LoaderCircle, RefreshCw, X } from "lucide-react";
import { showModal } from "../dialog-compat";
import {
  nativeUpdates,
  UpdateController,
  updateBlocker,
  type UpdateService,
} from "../app-update";
import "./AppUpdate.css";

export function AppUpdate({
  dirty,
  busy,
  extraBlocker,
  service = nativeUpdates,
}: {
  dirty: boolean;
  busy: boolean;
  extraBlocker?: () => string | undefined;
  service?: UpdateService;
}) {
  const [controller] = useState(() => new UpdateController(service));
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const blockers = useRef({ dirty, busy, extraBlocker });
  blockers.current = { dirty, busy, extraBlocker };
  const blocked = updateBlocker(dirty, busy) || extraBlocker?.();
  const downloading = state.stage === "downloading";
  const installing = state.stage === "installing";
  const working = downloading || installing;
  const available = !!state.release;
  useEffect(() => {
    let lastCheck = 0;
    const check = () => {
      lastCheck = Date.now();
      void controller.check();
    };
    const initial = window.setTimeout(check, 20_000);
    const interval = window.setInterval(check, 6 * 60 * 60 * 1000);
    const focus = () => {
      if (Date.now() - lastCheck > 6 * 60 * 60 * 1000) check();
    };
    window.addEventListener("focus", focus);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
      window.removeEventListener("focus", focus);
    };
  }, [controller]);
  useEffect(() => {
    if (open) showModal(ref.current);
  }, [open]);
  const close = () => {
    if (!working) setOpen(false);
  };
  return (
    <>
      <button
        className={`app-update-indicator ${available ? "available" : ""}`}
        aria-label={
          available
            ? `ShellCanvas ${state.release!.version} is available`
            : "Check for ShellCanvas updates"
        }
        title={
          available
            ? `Update to ShellCanvas ${state.release!.version}`
            : "ShellCanvas updates"
        }
        onClick={() => {
          setOpen(true);
          if (!available && state.stage !== "checking") void controller.check();
        }}
      >
        {working || state.stage === "checking" ? (
          <LoaderCircle size={16} className="update-spin" />
        ) : (
          <ArrowDownToLine size={16} />
        )}
        {available && <span className="update-dot" />}
      </button>
      {open &&
        createPortal(
          <dialog
            ref={ref}
            className="app-update-dialog"
            aria-labelledby="app-update-title"
            onCancel={(event) => {
              event.preventDefault();
              close();
            }}
          >
            <div className="app-update-heading">
              <p className="eyebrow">SHELLCANVAS UPDATE</p>
              <button
                aria-label="Close update dialog"
                disabled={working}
                onClick={close}
              >
                <X size={18} />
              </button>
            </div>
            <h2 id="app-update-title">
              {available
                ? `ShellCanvas ${state.release!.version}`
                : "Keep ShellCanvas up to date"}
            </h2>
            {state.stage === "checking" && (
              <p role="status">Checking for a signed update for this system…</p>
            )}
            {state.stage === "current" && (
              <p role="status">
                You’re using the latest available version for this system.
              </p>
            )}
            {available && (
              <>
                <p>Installed: {state.release!.currentVersion}</p>
                {state.release!.notes && (
                  <details className="app-update-notes">
                    <summary>What’s new</summary>
                    <pre>{state.release!.notes}</pre>
                  </details>
                )}
                <p>
                  ShellCanvas will download and verify the update, close this
                  app, and install it. Remote sessions will disconnect. Your
                  saved hosts, settings, installed apps and app data will be
                  kept.
                </p>
                <p>
                  Save your work first. Active transfers, app tasks and attached
                  drives must be finished or detached before installation.
                </p>
              </>
            )}
            {(blocked || state.error) && (
              <p className="app-update-error" role="alert">
                {blocked || state.error}
              </p>
            )}
            {downloading && (
              <div role="status">
                <p>
                  Downloading and verifying…{" "}
                  {state.progress
                    ? `${(state.progress.downloaded / 1048576).toFixed(1)} MB`
                    : ""}
                </p>
                <progress
                  max={state.progress?.total || undefined}
                  value={
                    state.progress?.total
                      ? state.progress.downloaded
                      : undefined
                  }
                />
              </div>
            )}
            {installing && (
              <p role="status">
                Installing the verified update. ShellCanvas will close…
              </p>
            )}
            <div className="app-update-actions">
              {downloading ? (
                <button onClick={() => void controller.cancel()}>
                  Cancel download
                </button>
              ) : (
                <button disabled={installing} onClick={close}>
                  Keep working
                </button>
              )}
              {available ? (
                <button
                  className="primary"
                  disabled={working || !!blocked}
                  onClick={() =>
                    void controller.apply(
                      () =>
                        updateBlocker(
                          blockers.current.dirty,
                          blockers.current.busy,
                        ) || blockers.current.extraBlocker?.(),
                    )
                  }
                >
                  {working ? "Updating…" : "Update and close"}
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={state.stage === "checking"}
                  onClick={() => void controller.check()}
                >
                  <RefreshCw size={15} /> Check again
                </button>
              )}
            </div>
          </dialog>,
          document.body,
        )}
    </>
  );
}
