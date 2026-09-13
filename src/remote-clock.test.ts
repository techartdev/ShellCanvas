// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import {
  anchorClock,
  remoteDate,
  offsetLabel,
  usableClockAnchor,
} from "./remote-clock";

describe("remote desktop clock", () => {
  it("retains a recent sample across a failed refresh but expires it and isolates hosts", () => {
    const anchor = anchorClock({ unixMs: 1_000_000, offsetMinutes: 180 }, 0, 0);
    const sample = { key: "host-a", anchor };
    expect(usableClockAnchor(sample, "host-a", true, 70_000)).toBe(anchor);
    expect(usableClockAnchor(sample, "host-a", true, 120_000)).toBeNull();
    expect(usableClockAnchor(sample, "host-b", true, 70_000)).toBeNull();
    expect(usableClockAnchor(sample, "host-a", false, 70_000)).toBeNull();
  });
  it("uses the host instant and offset across a date boundary", () => {
    const anchor = anchorClock(
      { unixMs: Date.UTC(2026, 8, 12, 22, 30), offsetMinutes: 180 },
      100,
      100,
    );
    expect(remoteDate(anchor, 100).toISOString()).toBe(
      "2026-09-13T01:30:00.000Z",
    );
  });
  it("supports negative and fractional-hour offsets", () => {
    const time = Date.UTC(2026, 8, 12, 1);
    expect(
      remoteDate(
        anchorClock({ unixMs: time, offsetMinutes: -420 }, 0, 0),
        0,
      ).toISOString(),
    ).toBe("2026-09-11T18:00:00.000Z");
    expect(offsetLabel(345)).toBe("UTC+05:45");
    expect(offsetLabel(-210)).toBe("UTC−03:30");
  });
  it("advances by elapsed monotonic time and accounts for response latency", () => {
    const anchor = anchorClock(
      { unixMs: 1_000_000, offsetMinutes: 0 },
      100,
      300,
    );
    expect(remoteDate(anchor, 2300).getTime()).toBe(1_002_100);
  });
  it("uses a newly sampled offset after a timezone or DST change", () => {
    const now = Date.UTC(2026, 8, 12);
    const before = anchorClock({ unixMs: now, offsetMinutes: 60 }, 0, 0);
    const after = anchorClock({ unixMs: now, offsetMinutes: 120 }, 0, 0);
    expect(
      remoteDate(after, 0).getTime() - remoteDate(before, 0).getTime(),
    ).toBe(3_600_000);
  });
  it("rejects malformed clock data instead of displaying an invalid date", () => {
    for (const sample of [
      { unixMs: NaN, offsetMinutes: 0 },
      { unixMs: 0, offsetMinutes: 1.5 },
      { unixMs: 0, offsetMinutes: 2000 },
      { unixMs: 9e15, offsetMinutes: 0 },
    ])
      expect(() => anchorClock(sample, 0, 0)).toThrow();
  });
});
