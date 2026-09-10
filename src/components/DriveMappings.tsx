// SPDX-License-Identifier: MPL-2.0
import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  FolderOpen,
  HardDrive,
  LoaderCircle,
  RotateCw,
  Unplug,
  X,
} from "lucide-react";
import "./DriveMappings.css";

export interface DriveMapping {
  hostLabel: string;
  id: string;
  sessionId: number;
  remotePath: string;
  localPath: string;
  writable: boolean;
  source: { instance: number; generation: number; adapter: string };
  status: {
    phase: "Starting" | "Attached" | "Detaching" | "Detached" | "Failed";
    message?: string | null;
  };
  running: boolean;
  cleanupWarning?: string | null;
  canRetryCleanup?: boolean;
  canCancelStartup?: boolean;
  startupCanceled?: boolean;
}
export function DriveMappings({ only }: { only?: string }) {
  const [items, setItems] = useState<DriveMapping[]>([]);
  const [error, setError] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const values = await invoke<DriveMapping[]>("drive_mappings");
        if (alive) setItems(values);
      } catch (e) {
        if (alive) setError(String(e));
      }
      if (alive) timer = setTimeout(() => void refresh(), 1000);
    }
    void refresh();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  async function action(item: DriveMapping, command: string) {
    if (working) return;
    setWorking(item.id);
    setError("");
    try {
      await invoke(command, {
        id: item.id,
      });
      if (command === "dismiss_drive")
        setItems((values) => values.filter((value) => value.id !== item.id));
      else if (command !== "open_drive_location")
        setItems(await invoke<DriveMapping[]>("drive_mappings"));
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(null);
    }
  }
  return (
    <section className="drive-mappings" aria-label="Local attachments">
      {!only && <h4>Local attachments</h4>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {!items.length && !only && (
        <p>
          No attached folders. In Files, right-click a folder and choose “Attach
          to this computer…”.
        </p>
      )}
      {items
        .filter((item) => !only || item.id === only)
        .map((item) => {
          const pending =
            !item.startupCanceled &&
            (item.status.phase === "Starting" ||
              item.status.phase === "Detaching");
          return (
            <article className="drive-mapping" key={item.id}>
              <div className="drive-mapping-heading">
                <HardDrive size={21} />
                <strong>{item.localPath}</strong>
                <span>{item.writable ? "Read & write" : "Read only"}</span>
              </div>
              <p className="drive-mapping-path">{item.remotePath}</p>
              <small>{item.hostLabel}</small>
              <div className="drive-mapping-status">
                <span>
                  {pending && <LoaderCircle size={14} className="spin" />}
                  {item.startupCanceled ? "Canceled" : item.status.phase}
                  {item.status.phase === "Detached" && item.running
                    ? " · finishing cleanup"
                    : ""}
                </span>
                <div className="drive-mapping-actions">
                  {item.running && item.status.phase === "Attached" && (
                    <button
                      type="button"
                      disabled={!!working}
                      onClick={() => void action(item, "open_drive_location")}
                    >
                      <FolderOpen size={14} /> Open folder
                    </button>
                  )}
                  {item.canCancelStartup ? (
                    <button
                      type="button"
                      disabled={!!working}
                      onClick={() => void action(item, "cancel_drive_startup")}
                    >
                      <X size={14} /> Cancel attachment
                    </button>
                  ) : item.canRetryCleanup ? (
                    <button
                      type="button"
                      disabled={!!working}
                      onClick={() => void action(item, "retry_drive_cleanup")}
                    >
                      <RotateCw size={14} /> Retry cleanup
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={
                        !!working ||
                        (item.running && item.status.phase !== "Attached")
                      }
                      onClick={() =>
                        void action(
                          item,
                          item.running ? "detach_drive" : "dismiss_drive",
                        )
                      }
                    >
                      {item.running ? <Unplug size={14} /> : <X size={14} />}
                      {item.running ? "Detach" : "Dismiss"}
                    </button>
                  )}
                </div>
              </div>
              {(item.cleanupWarning || item.status.message) && (
                <p className="drive-mapping-notice" role="status">
                  {item.cleanupWarning || item.status.message}
                </p>
              )}
            </article>
          );
        })}
    </section>
  );
}
