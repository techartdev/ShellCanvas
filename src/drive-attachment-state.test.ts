// SPDX-License-Identifier: MPL-2.0
import { expect, it } from "vitest";
import { attachmentsForLocation } from "./drive-attachment-state";
import type { DriveMapping } from "./components/DriveMappings";
const source = { instance: 4, generation: 1, adapter: "ssh" };
const mapping: DriveMapping = {
  id: "mapping",
  hostLabel: "Windows host",
  sessionId: 7,
  source,
  remotePath: "/D:/",
  localPath: "W:",
  writable: false,
  status: { phase: "Attached" },
  running: true,
};
it("shows the local attachment for the same Windows drive and exact connection", () => {
  expect(attachmentsForLocation([mapping], 7, source, "D:\\", true)).toEqual([
    mapping,
  ]);
  expect(attachmentsForLocation([mapping], 8, source, "/D:/", true)).toEqual(
    [],
  );
  expect(
    attachmentsForLocation(
      [mapping],
      7,
      { ...source, generation: 2 },
      "/D:/",
      true,
    ),
  ).toEqual([]);
  expect(attachmentsForLocation([mapping], 7, null, "/D:/", true)).toEqual([]);
  expect(
    attachmentsForLocation([mapping], 7, source, "/D:/folder", true),
  ).toEqual([]);
});
it("retains busy cleanup state, removes detached state, and preserves Unix case", () => {
  expect(
    attachmentsForLocation(
      [{ ...mapping, running: false }],
      7,
      source,
      "/D:/",
      true,
    ),
  ).toEqual([]);
  expect(
    attachmentsForLocation(
      [{ ...mapping, running: false, canRetryCleanup: true }],
      7,
      source,
      "/D:/",
      true,
    ),
  ).toHaveLength(1);
  expect(
    attachmentsForLocation(
      [{ ...mapping, remotePath: "/Data/" }],
      7,
      source,
      "/data",
      false,
    ),
  ).toEqual([]);
});
