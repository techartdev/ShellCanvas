import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { previewServices, previewSession } from "../../src/preview";
import type { FileVolumes } from "../../src/sdk";
import "../../src/styles.css";
let revision = 1;
const snapshot: FileVolumes = {
  revision: "1",
  notices: ["Synthetic device. No real host or disk is changed."],
  volumes: [
    {
      id: "root",
      name: "System",
      detail: "APFS · startup volume",
      locations: [{ path: "/", name: "/" }],
      system: true,
      canMount: false,
      canUnmount: false,
    },
    {
      id: "work",
      name: "Studio files",
      detail: "disk2s1 · APFS",
      locations: [{ path: "/srv", name: "/Volumes/Studio files" }],
      system: false,
      canMount: false,
      canUnmount: true,
    },
    {
      id: "archive",
      name: "Archive",
      detail: "disk3s1 · APFS",
      locations: [],
      system: false,
      canMount: true,
      canUnmount: false,
    },
    {
      id: "network",
      name: "Team network share with a longer display name",
      detail: "server:/team · nfs",
      locations: [{ path: "/var", name: "/mnt/Shared projects" }],
      system: false,
      canMount: false,
      canUnmount: false,
    },
  ],
};
const events: string[] = [];
Object.assign(window, { volumeEvents: events });
createRoot(document.getElementById("root")!).render(
  <App
    isNative
    services={{
      ...previewServices,
      volumes: async () => {
        events.push("list");
        if (new URLSearchParams(location.search).has("fail"))
          throw new Error("Drive discovery denied");
        return structuredClone({ ...snapshot, revision: String(revision) });
      },
      setVolumeMounted: async (_, id, reviewed, mounted) => {
        if (reviewed !== String(revision))
          throw new Error("Drives changed since review");
        const volume = snapshot.volumes.find((v) => v.id === id)!;
        events.push(`${mounted ? "mount" : "unmount"}:${id}`);
        volume.locations = mounted
          ? [{ path: "/srv", name: "/Volumes/Archive" }]
          : [];
        volume.canMount = !mounted;
        volume.canUnmount = mounted;
        revision++;
      },
    }}
    initialSession={{
      ...previewSession,
      info: {
        ...previewSession.info,
        hostname: "MacBook Air",
        provider: "macos",
        system: "macOS 10.15.8",
      },
    }}
  />,
);
