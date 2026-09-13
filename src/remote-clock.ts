// SPDX-License-Identifier: MPL-2.0
export interface ClockSample {
  unixMs: number;
  offsetMinutes: number;
}
export interface ClockAnchor extends ClockSample {
  receivedAt: number;
}

export function usableClockAnchor(
  sample: { key: string; anchor: ClockAnchor } | null,
  key: string,
  connected: boolean,
  now: number,
): ClockAnchor | null {
  return sample?.key === key &&
    connected &&
    now - sample.anchor.receivedAt < 120_000
    ? sample.anchor
    : null;
}

export function anchorClock(
  sample: ClockSample,
  started: number,
  received: number,
): ClockAnchor {
  if (
    !Number.isFinite(sample.unixMs) ||
    Math.abs(sample.unixMs) > 8.64e15 - 86_400_000 ||
    !Number.isInteger(sample.offsetMinutes) ||
    Math.abs(sample.offsetMinutes) > 1439
  )
    throw new Error("Invalid remote clock sample");
  // Approximate the response's transit time. The host clock has second precision.
  return {
    ...sample,
    unixMs: sample.unixMs + Math.max(0, received - started) / 2,
    receivedAt: received,
  };
}
export function remoteDate(anchor: ClockAnchor, now: number): Date {
  return new Date(
    anchor.unixMs +
      Math.max(0, now - anchor.receivedAt) +
      anchor.offsetMinutes * 60_000,
  );
}
export function offsetLabel(minutes: number): string {
  return `UTC${minutes < 0 ? "−" : "+"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
}
