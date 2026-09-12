// SPDX-License-Identifier: MPL-2.0
import { useEffect, useState } from "react";
import type { HostServices, Session } from "./sdk";
import {
  anchorClock,
  remoteDate,
  offsetLabel,
  type ClockAnchor,
} from "./remote-clock";

export function useRemoteClock(
  services: HostServices,
  session: Session | null,
  connected: boolean,
  label: string,
) {
  const source = session?.services?.find(
    (item) => item.capability === "terminal",
  )?.source;
  const key = JSON.stringify([
    session?.id,
    session?.sourceRevision,
    source,
    connected,
  ]);
  const [sample, setSample] = useState<{
    key: string;
    anchor: ClockAnchor;
  } | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!session || !connected || !services.readClock) return;
    let disposed = false;
    let pending = false;
    const refresh = async () => {
      if (pending || disposed) return;
      pending = true;
      const started = performance.now();
      try {
        const value = await services.readClock!(
          session.id,
          source ?? undefined,
        );
        if (!disposed)
          setSample({
            key,
            anchor: anchorClock(value, started, performance.now()),
          });
      } catch {
        if (!disposed) setSample(null);
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    const wake = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [services, key]);
  const anchor =
    sample?.key === key &&
    connected &&
    performance.now() - sample.anchor.receivedAt < 120_000
      ? sample.anchor
      : null;
  return {
    date: anchor ? remoteDate(anchor, performance.now()) : new Date(),
    timeZone: anchor ? "UTC" : undefined,
    local: !anchor,
    title: anchor
      ? `Remote time · ${label} · ${offsetLabel(anchor.offsetMinutes)}`
      : session
        ? "Local device time · remote clock unavailable or synchronizing"
        : "Local device time",
  };
}
