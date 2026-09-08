// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "vitest";
import { unavailableReason, type DesktopApp, type Session } from "./sdk";
const app = { scope: "host", requires: ["files.read"] } as DesktopApp;
describe("capability-driven desktop", () => {
  it("keeps local apps available without an SSH session", () => {
    expect(
      unavailableReason(
        { scope: "local", requires: [] } as unknown as DesktopApp,
        null,
      ),
    ).toBeNull();
  });
  it("distinguishes disconnected hosts from missing SFTP", () => {
    expect(unavailableReason(app, null)).toContain("Connect");
    expect(
      unavailableReason(app, {
        info: { capabilities: ["terminal"] },
      } as Session),
    ).toContain("file browsing");
    expect(
      unavailableReason(app, {
        info: { capabilities: ["files.read"] },
      } as Session),
    ).toBeNull();
  });
  it("keeps app availability independent of transport and OS names", () => {
    const terminal = { scope: "host", requires: ["terminal"] } as DesktopApp;
    const details = { scope: "host", requires: [] } as unknown as DesktopApp;
    const apiDevice = {
      info: { provider: "fixture-api", capabilities: ["files.read"] },
    } as Session;
    expect(unavailableReason(app, apiDevice)).toBeNull();
    expect(unavailableReason(terminal, apiDevice)).toContain("terminal");
    const consoleDevice = {
      info: { provider: "fixture-console", capabilities: ["terminal"] },
    } as Session;
    expect(unavailableReason(app, consoleDevice)).toContain("file browsing");
    expect(unavailableReason(terminal, consoleDevice)).toBeNull();
    expect(
      unavailableReason(details, {
        info: { capabilities: [] },
      } as unknown as Session),
    ).toBeNull();
  });
});
