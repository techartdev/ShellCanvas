// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from "react";
import {
  HardDrive,
  FolderOpen,
  RefreshCw,
  ArrowLeft,
  LoaderCircle,
} from "lucide-react";
import type {
  FileVolume,
  FileVolumes as Inventory,
  SessionServices,
} from "../sdk";
import { FileActionDialog } from "./FileActionDialog";
import "./FileVolumes.css";

export function FileVolumes({
  services,
  connected,
  host,
  navigate,
  back,
  setBusy,
}: {
  services: SessionServices;
  connected: boolean;
  host: string;
  navigate(path: string): void;
  back(): void;
  setBusy(busy: boolean): void;
}) {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  const [review, setReview] = useState<{
    volume: FileVolume;
    revision: string;
    services: SessionServices;
    mounted: boolean;
  } | null>(null);
  const epoch = useRef(0);
  async function refresh() {
    const current = ++epoch.current;
    setError("");
    setLoading(true);
    try {
      const next = services.volumes
        ? await services.volumes()
        : {
            revision: "",
            volumes: [],
            notices: [
              "This provider does not offer drive discovery. Use Home, filesystem locations, or enter a known path.",
            ],
          };
      if (current === epoch.current) setInventory(next);
    } catch (e) {
      if (current === epoch.current) setError(String(e));
    } finally {
      if (current === epoch.current) setLoading(false);
    }
  }
  useEffect(() => {
    setInventory(null);
    setReview(null);
    if (connected) void refresh();
    return () => {
      ++epoch.current;
    };
  }, [services, connected]);
  const volumes =
    inventory?.volumes.filter((v) => showSystem || !v.system) ?? [];
  return (
    <section
      className="file-volumes"
      aria-label="Drives and mounts"
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest("dialog")) return;
        if (event.key === "F5") {
          event.preventDefault();
          if (connected && !loading && !working) void refresh();
        } else if (event.altKey && event.key === "ArrowLeft") {
          event.preventDefault();
          if (!working) back();
        }
      }}
    >
      <header className="file-volumes-toolbar">
        <button
          className="icon-button"
          aria-label="Back to files"
          disabled={working}
          onClick={back}
        >
          <ArrowLeft size={17} />
        </button>
        <div>
          <h2>Drives and mounts</h2>
          <p>{host}</p>
        </div>
        <button
          className="icon-button"
          aria-label="Refresh drives"
          title="Refresh drives"
          disabled={!connected || loading || working}
          onClick={() => void refresh()}
        >
          <RefreshCw size={17} className={loading ? "spin" : ""} />
        </button>
      </header>
      <div className="file-volumes-body">
        <label className="file-volumes-filter">
          <input
            type="checkbox"
            checked={showSystem}
            onChange={(e) => setShowSystem(e.target.checked)}
          />{" "}
          Show system mounts
        </label>
        {!connected && (
          <p role="status">Connect this host to browse its drives.</p>
        )}
        {error && (
          <p className="inline-error" role="alert">
            {error} Use Refresh drives to retry.
          </p>
        )}
        {loading && (
          <p role="status">
            <LoaderCircle size={14} className="spin" /> Discovering drives…
          </p>
        )}
        <div className="file-volumes-grid">
          {volumes.map((volume) => (
            <article className="file-volume-card" key={volume.id}>
              <div className="file-volume-heading">
                <HardDrive size={25} />
                <div>
                  <h3>{volume.name}</h3>
                  <p>{volume.detail}</p>
                </div>
              </div>
              {volume.locations.length ? (
                <div className="file-volume-paths">
                  {volume.locations.map((location) => (
                    <button
                      key={location.path}
                      title={`Browse ${location.path}`}
                      disabled={!connected || working}
                      onClick={() => navigate(location.path)}
                    >
                      <FolderOpen size={15} />
                      <span>{location.name}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="file-volume-status">No mounted location</p>
              )}
              {services.setVolumeMounted &&
                !volume.system &&
                (volume.canMount || volume.canUnmount) && (
                  <button
                    className="file-volume-action"
                    disabled={!connected || loading || working || !!error}
                    onClick={() =>
                      setReview({
                        volume,
                        revision: inventory!.revision,
                        services,
                        mounted: volume.canMount,
                      })
                    }
                  >
                    {volume.canMount ? "Mount…" : "Unmount…"}
                  </button>
                )}
            </article>
          ))}
        </div>
        {inventory && !volumes.length && !loading && (
          <p className="file-volume-status">
            No {showSystem ? "" : "additional "}volumes to show.
            {!showSystem && inventory.volumes.some((v) => v.system)
              ? " Enable Show system mounts to see the filesystem and system locations."
              : ""}
          </p>
        )}
        {inventory?.notices.map((notice, i) => (
          <p className="file-volume-notice" key={i}>
            {notice}
          </p>
        ))}
        <p className="file-volume-notice">
          Locations are provided by this host. Access depends on your account
          and the file service.
        </p>
      </div>
      {review && (
        <FileActionDialog
          title={review.mounted ? "Mount this volume?" : "Unmount this volume?"}
          description={`${host}. ${review.mounted ? "Make this volume accessible using the host's mount service and your current account." : "Close files and finish transfers using this volume first. Other applications may also be using it; busy volumes will not be forcibly unmounted."}`}
          initialName={`${review.volume.name} · ${review.volume.detail}`}
          readOnlyName
          confirmLabel={review.mounted ? "Mount volume" : "Unmount volume"}
          disabled={!connected || services !== review.services}
          close={() => setReview(null)}
          setBusy={(busy) => {
            setWorking(busy);
            setBusy(busy);
          }}
          execute={async () => {
            if (!connected || services !== review.services)
              throw new Error(
                "The file connection changed. Review the volume again.",
              );
            const operationEpoch = epoch.current;
            try {
              await review.services.setVolumeMounted!(
                review.volume.id,
                review.revision,
                review.mounted,
              );
            } finally {
              if (operationEpoch === epoch.current) await refresh();
            }
          }}
        />
      )}
    </section>
  );
}
