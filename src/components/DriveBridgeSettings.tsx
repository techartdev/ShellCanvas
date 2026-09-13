// SPDX-License-Identifier: MPL-2.0
import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { HardDrive, LoaderCircle, ShieldCheck } from "lucide-react";
import "./DriveBridgeSettings.css";
import { DriveMappings } from "./DriveMappings";
import { readClientEnvironment } from "../extensions/client-platform";
import { clientCompatibilityReason } from "../../packages/app-sdk/src/client-platform";

type Installation = {
  version: number;
  name: string;
  sha256: string;
  size: number;
  releaseVersion?: string;
  target?: string;
};
type ReleaseStatus = {
  version: string;
  target: string;
  available: boolean;
  updateAvailable: boolean;
  driver: { name: string; detected: boolean; guidance: string; url: string };
};
type Review = { id: string; source: string; installation: Installation };
export function DriveBridgeSettings() {
  const [installed, setInstalled] = useState<Installation | null>(null);
  const [installationStatus, setInstallationStatus] = useState(
    "Checking installation…",
  );
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [compatible, setCompatible] = useState(false);
  const [release, setRelease] = useState<ReleaseStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const alive = useRef(true);
  const pending = useRef<string | null>(null);
  const working = useRef(false);
  const native = isTauri();
  async function checkRelease() {
    if (checking) return;
    setChecking(true);
    setError("");
    try {
      const value = await invoke<ReleaseStatus>("drive_bridge_release_status");
      if (alive.current) setRelease(value);
    } catch (e) {
      if (alive.current) {
        setRelease(null);
        setError(String(e));
      }
    } finally {
      if (alive.current) setChecking(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    if (native)
      void readClientEnvironment()
        .then(async (client) => {
          const reason = clientCompatibilityReason(
            { clientPlatforms: ["windows", "macos", "linux"] },
            client,
          );
          if (!alive.current) return undefined;
          setCompatible(!reason);
          if (reason) {
            setInstallationStatus(reason);
            return undefined;
          }
          return invoke<Installation | null>("drive_bridge_installation");
        })
        .then((value) => {
          if (alive.current && value !== undefined) {
            setInstalled(value);
            setInstallationStatus(
              value ? "Bridge installed" : "No bridge installed",
            );
            void checkRelease();
          }
        })
        .catch((e) => {
          if (alive.current) {
            setError(String(e));
            setInstallationStatus("Couldn’t verify installation");
          }
        });
    return () => {
      alive.current = false;
      if (pending.current)
        void invoke("cancel_drive_bridge_review", {
          id: pending.current,
        }).catch(() => {});
    };
  }, [native]);
  async function choose(official = false) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      const candidate = await invoke<Review | null>(
        official ? "download_drive_bridge" : "review_drive_bridge",
      );
      if (!alive.current) {
        if (candidate)
          await invoke("cancel_drive_bridge_review", { id: candidate.id });
        return;
      }
      pending.current = candidate?.id ?? null;
      setReview(candidate);
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function finish(approve: boolean) {
    if (!review || working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    const id = review.id;
    let completed = false;
    try {
      if (approve) {
        const saved = await invoke<Installation>("install_drive_bridge", {
          id,
        });
        if (alive.current) {
          setInstalled(saved);
          setInstallationStatus("Bridge installed");
          void checkRelease();
        }
      } else await invoke("cancel_drive_bridge_review", { id });
      completed = true;
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (completed) pending.current = null;
      working.current = false;
      if (alive.current) {
        if (completed) setReview(null);
        setBusy(false);
      }
    }
  }
  return (
    <section
      className="drive-bridge-settings"
      aria-labelledby="drive-bridge-heading"
    >
      <header>
        <span className="drive-bridge-icon">
          <HardDrive size={22} />
        </span>
        <div>
          <h3 id="drive-bridge-heading">Drive Bridge</h3>
          <p>Use remote folders from your local apps.</p>
        </div>
        <span className="drive-bridge-badge">Optional</span>
      </header>
      <p>
        Install the free bridge for this computer, then attach a folder from
        Files. ShellCanvas verifies official downloads before installation. The
        filesystem driver is installed separately.
      </p>
      {error && (
        <p role="alert" className="drive-bridge-error">
          {error}
        </p>
      )}
      {review ? (
        <div className="drive-bridge-review">
          <h4>
            <ShieldCheck size={17} /> Review native app installation
          </h4>
          <p>
            {review.installation.releaseVersion
              ? `Official Drive Bridge ${review.installation.releaseVersion}. Publisher signature and download integrity verified.`
              : "This is a local build. Its publisher signature has not been verified."}{" "}
            The bridge runs with your local account’s permissions when you
            attach a folder.
          </p>
          <dl>
            <dt>File</dt>
            <dd>{review.source}</dd>
            <dt>Size</dt>
            <dd>{(review.installation.size / 1048576).toFixed(1)} MB</dd>
            <dt>SHA-256</dt>
            <dd>
              <code>{review.installation.sha256}</code>
            </dd>
          </dl>
          <p className="drive-bridge-note">
            {review.installation.releaseVersion
              ? "Installed privately in your ShellCanvas profile. Detach local drives before updating."
              : "The hash identifies the reviewed bytes. It is not a publisher signature."}
          </p>
          <div className="drive-bridge-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => void finish(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="drive-bridge-primary"
              disabled={busy}
              onClick={() => void finish(true)}
            >
              {busy && <LoaderCircle className="spin" size={15} />}
              {review.installation.releaseVersion
                ? "Install Drive Bridge"
                : "Trust and install local build"}
            </button>
          </div>
        </div>
      ) : (
        <div className="drive-bridge-installation">
          <div>
            <strong>
              {native ? installationStatus : "Available in the desktop app"}
            </strong>
            <p>
              {installed
                ? installed.releaseVersion
                  ? `Version ${installed.releaseVersion} · ${installed.target}`
                  : "Local development build"
                : native && compatible
                  ? release
                    ? `Version ${release.version} · ${release.target}`
                    : checking
                      ? "Checking official releases…"
                      : "Release information unavailable"
                  : "Install and attach drives in the desktop app."}
            </p>
          </div>
          <button
            type="button"
            className="drive-bridge-primary"
            disabled={
              !native ||
              !compatible ||
              busy ||
              checking ||
              !release?.available ||
              (!!installed && !release.updateAvailable)
            }
            onClick={() => void choose(true)}
          >
            {busy ? <LoaderCircle className="spin" size={15} /> : null}
            {busy
              ? "Downloading and verifying…"
              : !release
                ? checking
                  ? "Checking…"
                  : "Release unavailable"
                : installed
                  ? release?.updateAvailable
                    ? "Update Drive Bridge"
                    : "Up to date"
                  : "Install Drive Bridge"}
          </button>
        </div>
      )}
      {native && compatible && !review && (
        <button disabled={busy || checking} onClick={() => void checkRelease()}>
          {checking ? "Checking…" : "Check for updates and drivers"}
        </button>
      )}
      {release && (
        <div className="drive-bridge-driver" role="status">
          {!release.available && (
            <p>No release package is published for {release.target} yet.</p>
          )}
          <strong>
            {release.driver.name}:{" "}
            {release.driver.detected ? "detected" : "setup required"}
          </strong>
          <p>
            {release.driver.detected
              ? "The runtime was found. Attaching a folder will check whether it is ready to use."
              : release.driver.guidance}
          </p>
          {!release.driver.detected && (
            <a href={release.driver.url} target="_blank" rel="noreferrer">
              {release.driver.name} setup instructions ↗
            </a>
          )}
        </div>
      )}
      <DriveMappings />
      <details>
        <summary>Advanced · install a local executable</summary>
        <p>
          For offline installation and development builds. Official releases do
          not require selecting a file.
        </p>
        <button
          disabled={!native || !compatible || busy || !!review}
          onClick={() => void choose(false)}
        >
          Choose local executable…
        </button>
      </details>
      <details>
        <summary>Drivers and licensing</summary>
        <div className="drive-bridge-notices">
          <p>
            Drive Bridge is GPL-3.0-only free software. Commercial use is
            permitted under its license; redistribution has source and notice
            obligations. ShellCanvas’s core remains MPL-2.0.
          </p>
          <ul>
            <li>
              <strong>Windows:</strong> WinFsp runtime. Installing its driver
              requires administrator approval. The native runtime and Rust
              bindings have separate licensing terms.
            </li>
            <li>
              <strong>Linux:</strong> FUSE and your distribution’s mount helper.
            </li>
            <li>
              <strong>macOS:</strong> macFUSE, installed separately. Its license
              restricts commercial bundling and automated installation in that
              context without permission.
            </li>
          </ul>
          <p>
            The bridge includes notices through <code>--licenses</code>. Current
            source, build instructions and verification status are at{" "}
            <a
              href="https://github.com/techartdev/ShellCanvas-DriveBridge"
              target="_blank"
              rel="noreferrer"
            >
              ShellCanvas Drive Bridge
            </a>
            .
          </p>
        </div>
      </details>
    </section>
  );
}
