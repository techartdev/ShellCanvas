// SPDX-License-Identifier: MPL-2.0
// Synthetic services only; never connects to hosts or reads their clocks.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useRemoteClock } from "../../src/use-remote-clock";
import { previewServices, previewSession } from "../../src/preview";
import type { Session } from "../../src/sdk";
import type { ClockSample } from "../../src/remote-clock";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const result = document.querySelector("#result")!;
const root = createRoot(document.querySelector("#root")!);
const pending: {
  id: number;
  resolve(value: ClockSample): void;
  reject(error: Error): void;
}[] = [];
const services = {
  ...previewServices,
  readClock: (id: number) =>
    new Promise<ClockSample>((resolve, reject) =>
      pending.push({ id, resolve, reject }),
    ),
};
let current: ReturnType<typeof useRemoteClock>;
function Probe({
  session,
  connected = true,
}: {
  session: Session | null;
  connected?: boolean;
}) {
  current = useRemoteClock(services, session, connected, `Host ${session?.id}`);
  return (
    <time title={current.title}>
      {current.local ? "Local" : current.date.toISOString()}
    </time>
  );
}
function check(value: boolean, message: string) {
  if (!value) throw new Error(message);
}
const first = { ...previewSession, id: 101 };
const second = { ...previewSession, id: 102 };
const sample = { unixMs: Date.UTC(2026, 8, 12, 22), offsetMinutes: 180 };
try {
  await act(async () => root.render(<Probe session={first} />));
  check(current!.local, "Pending clock must be labelled local");
  await act(async () => root.render(<Probe session={second} />));
  await act(async () => pending[0].resolve(sample));
  check(current!.local, "Late reply from previous host must be ignored");
  await act(async () => pending[1].resolve(sample));
  check(
    !current!.local &&
      current!.title.includes("Host 102") &&
      current!.date.getUTCDate() === 13,
    "Active host must supply time and date",
  );
  await act(async () =>
    root.render(<Probe session={{ ...second, sourceRevision: 9 }} />),
  );
  check(
    current!.local,
    "Replacing a source must invalidate its clock immediately",
  );
  await act(async () => pending[2].reject(new Error("Fixture unavailable")));
  check(current!.local, "Unavailable clock must fall back explicitly");
  await act(async () =>
    root.render(<Probe session={second} connected={false} />),
  );
  check(
    current!.local && pending.length === 3,
    "Disconnected workspace must not query the clock",
  );
  await act(async () => root.render(<Probe session={null} />));
  check(current!.local, "Local workspace must use local time");
  result.textContent =
    "PASS: pending fallback, stale host reply, remote date, source replacement, failed probe, disconnect, local workspace";
} catch (error) {
  result.textContent = `FAIL: ${error}`;
  throw error;
} finally {
  await act(async () => root.unmount());
}
