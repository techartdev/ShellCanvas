// SPDX-License-Identifier: MPL-2.0
import { expect, it } from "vitest";
import { previewSession } from "./preview";
import type { Session } from "./sdk";
import { terminalDirectoryFor } from "./terminal-directory";

const source = { instance: 12, generation: 1, adapter: "ssh" };
const session: Session = {
  ...previewSession,
  info: { ...previewSession.info, provider: "linux" },
  services: [
    { capability: "files.read", state: "available", source },
    { capability: "terminal", state: "available", source },
  ],
};
it("retains the literal remote path and captures its source", () => {
  const result = terminalDirectoryFor(session, "/srv/John's site");
  expect(result).toEqual({ path: "/srv/John's site", source });
  expect(result?.source).not.toBe(source);
});
it("does not send paths between FTP and SSH or replaced connections", () => {
  for (const replacement of [
    { ...source, adapter: "ftp" },
    { ...source, instance: 13 },
    { ...source, generation: 2 },
  ]) {
    expect(
      terminalDirectoryFor(
        {
          ...session,
          services: [
            session.services![0],
            { ...session.services![1], source: replacement },
          ],
        },
        "/srv",
      ),
    ).toBeUndefined();
  }
});
it("disables directory startup for unavailable consoles and RouterOS", () => {
  expect(
    terminalDirectoryFor(
      {
        ...session,
        services: [
          session.services![0],
          { ...session.services![1], state: "disconnected" },
        ],
      },
      "/srv",
    ),
  ).toBeUndefined();
  expect(
    terminalDirectoryFor(
      { ...session, info: { ...session.info, provider: "routeros" } },
      "/srv",
    ),
  ).toBeUndefined();
});
