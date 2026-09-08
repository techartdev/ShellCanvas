// SPDX-License-Identifier: MPL-2.0
import { beforeEach, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { isFrameHandshake, mountAppDocument } from "./frame-document";
import { parseAppPackage } from "./package";
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));
const app = parseAppPackage(
  JSON.stringify({
    format: 1,
    kind: "app",
    id: "org.example.app",
    title: "App",
    version: "1.0.0",
    permissions: [],
    script: "console.log('app')",
    style: "",
  }),
);
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isTauri).mockReturnValue(true);
});
it("releases a late native publication after its frame owner closes", async () => {
  let publish!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation((command) =>
    command === "publish_app_frame"
      ? new Promise((resolve) => {
          publish = resolve;
        })
      : Promise.resolve(undefined),
  );
  const frame = {
    srcdoc: "",
    src: "",
    removeAttribute: vi.fn(),
  } as unknown as HTMLIFrameElement;
  const close = mountAppDocument(frame, app, "instance-one", vi.fn());
  close();
  publish({
    id: "old",
    url: "http://shellcanvas-app.localhost/old/index.html",
  });
  await turn();
  expect(frame.src).toBe("");
  expect(invoke).toHaveBeenLastCalledWith("release_app_frame", { id: "old" });
  expect(invoke).toHaveBeenCalledTimes(2);
  close();
  expect(invoke).toHaveBeenCalledTimes(2);
});
it("owns and retires a published native document and reports a failed publication", async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce({
      id: "current",
      url: "http://shellcanvas-app.localhost/current/index.html",
    })
    .mockResolvedValue(undefined);
  const frame = {
    srcdoc: "",
    src: "",
    removeAttribute: vi.fn(),
  } as unknown as HTMLIFrameElement;
  const failed = vi.fn();
  const close = mountAppDocument(frame, app, "instance-one", failed);
  await turn();
  expect(frame.src).toContain("/current/index.html");
  close();
  expect(invoke).toHaveBeenLastCalledWith("release_app_frame", {
    id: "current",
  });
  vi.mocked(invoke).mockRejectedValueOnce(new Error("Cannot create document"));
  mountAppDocument(frame, app, "instance-two", failed);
  await turn();
  expect(failed).toHaveBeenCalledWith("Error: Cannot create document");
});
it("rejects stale-generation handshakes even from a reused iframe window", () => {
  expect(
    isFrameHandshake(
      { type: "shellcanvas:ready:v1", token: "old" },
      "ready",
      "new",
    ),
  ).toBe(false);
  expect(isFrameHandshake("shellcanvas:ready:v1", "ready", "new")).toBe(false);
  expect(
    isFrameHandshake(
      { type: "shellcanvas:connect:v1", token: "new" },
      "ready",
      "new",
    ),
  ).toBe(false);
  expect(
    isFrameHandshake(
      { type: "shellcanvas:ready:v1", token: "new" },
      "ready",
      "new",
    ),
  ).toBe(true);
});
it("does not start the discarded browser document during StrictMode setup and cleanup", async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  const documents: string[] = [];
  const frame = {
    set srcdoc(value: string) {
      documents.push(value);
    },
    src: "",
    removeAttribute: vi.fn(),
  } as unknown as HTMLIFrameElement;
  const first = mountAppDocument(frame, app, "retired-token", vi.fn());
  first();
  const second = mountAppDocument(frame, app, "live-token", vi.fn());
  await turn();
  expect(documents).toHaveLength(1);
  expect(documents[0]).toContain('content="live-token"');
  second();
  expect(frame.src).toBe("about:blank");
});
