// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HardDrive, LoaderCircle } from "lucide-react";
import { showModal } from "../dialog-compat";
import type { DriveMappingAvailability, SessionServices } from "../sdk";
import { DriveMappings } from "./DriveMappings";
import "./FileActionDialog.css";
import "./DriveMappings.css";

export function AttachDriveDialog({
  path,
  host,
  services,
  close,
}: {
  path: string;
  host: string;
  services: SessionServices;
  close(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const [availability, setAvailability] =
    useState<DriveMappingAvailability | null>(null);
  const [writable, setWritable] = useState(false);
  const [drive, setDrive] = useState("Z:");
  const [working, setWorking] = useState(false);
  const [mapping, setMapping] = useState<string | null>(null);
  const [error, setError] = useState("");
  const availableDrives =
    availability?.availableDrives ??
    Array.from({ length: 23 }, (_, i) => `${String.fromCharCode(90 - i)}:`);
  const noDrive = availability?.windows && availableDrives.length === 0;
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    showModal(dialog.current);
    void (
      services.driveMappingAvailable?.() ??
      Promise.reject("Local attachments are available in the desktop app.")
    )
      .then((value) => {
        if (alive.current) {
          setAvailability(value);
          if (value.windows && value.availableDrives) {
            setDrive(value.availableDrives[0] ?? "");
          }
        }
      })
      .catch((e) => {
        if (alive.current) setError(String(e));
      });
    return () => {
      alive.current = false;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [services]);
  async function attach() {
    if (
      working ||
      !availability?.supported ||
      !availability.installed ||
      noDrive ||
      !services.attachDrive
    )
      return;
    setWorking(true);
    setError("");
    try {
      const id = await services.attachDrive(
        path,
        writable,
        availability.windows ? drive : undefined,
      );
      if (alive.current) setMapping(id);
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      if (alive.current) setWorking(false);
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="file-action-dialog attach-drive-dialog"
      aria-label="Attach to this computer"
      onCancel={(e) => {
        e.preventDefault();
        if (!working) close();
      }}
    >
      <div className="file-action-emblem">
        <HardDrive size={23} />
      </div>
      <p className="eyebrow">DRIVE BRIDGE</p>
      <h2>Attach to this computer</h2>
      <p className="file-action-description">
        Open this remote folder in your local apps. Keep ShellCanvas and this
        host connection open while you use it.
      </p>
      <div className="file-action-target">
        <strong>{host}</strong>
        <span>{path}</span>
      </div>
      {mapping ? (
        <>
          <DriveMappings only={mapping} />
          <p className="file-action-description">
            You can close this dialog. Manage attachments in Settings → Files.
          </p>
        </>
      ) : (
        <>
          {!availability && !error && (
            <p role="status">
              <LoaderCircle size={14} className="spin" /> Checking file access…
            </p>
          )}
          {availability && !availability.supported && (
            <p role="status">
              This provider can browse files but does not support local
              attachments.
            </p>
          )}
          {availability?.supported && !availability.installed && (
            <p role="status">
              First install Drive Bridge in Settings → Files. Driver setup and
              licensing notes are there too.
            </p>
          )}
          {availability?.supported && availability.installed && (
            <div className="attach-drive-options">
              {availability.windows ? (
                <label>
                  Local drive
                  <select
                    value={drive}
                    disabled={working || noDrive}
                    onChange={(e) => setDrive(e.target.value)}
                  >
                    {noDrive && <option value="">No free drive letters</option>}
                    {availableDrives.map((letter) => (
                      <option key={letter}>{letter}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <p>You’ll choose an empty local folder in the next step.</p>
              )}
              {noDrive && (
                <p role="status">
                  All drive letters from D: to Z: are in use. Detach a drive,
                  then reopen this dialog.
                </p>
              )}
              <label>
                File access
                <select
                  value={writable ? "write" : "read"}
                  disabled={working}
                  onChange={(e) => setWritable(e.target.value === "write")}
                >
                  <option value="read">Read only</option>
                  <option value="write">Read and write</option>
                </select>
              </label>
              <p>
                {writable
                  ? "Changes made by local apps are written to the remote host immediately."
                  : "Local apps can read files. Saving changes to the remote host is disabled."}
              </p>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="attach-drive-actions">
        <button type="button" disabled={working} onClick={close}>
          {mapping ? "Done" : "Cancel"}
        </button>
        {!mapping && (
          <button
            type="button"
            className="primary"
            disabled={
              working ||
              !availability?.supported ||
              !availability.installed ||
              noDrive
            }
            onClick={() => void attach()}
          >
            {working && <LoaderCircle size={14} className="spin" />}Attach
            {availability?.windows ? "" : "…"}
          </button>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
