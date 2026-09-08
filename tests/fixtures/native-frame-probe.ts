// SPDX-License-Identifier: MPL-2.0
import { Channel, invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import {
  RpcPeer,
  messagePortTransport,
  type Json,
} from "../../src/extensions/rpc";
import { systemMethods } from "../../src/extensions/system-bridge";
import { isFrameHandshake } from "../../src/extensions/frame-document";
import type { SystemAPI } from "../../src/system-api";
import source from "../../.local/native-extension-probe/client.js?raw";
type Published = { id: string; url: string };
async function probe() {
  const progress = (stage: string, detail?: unknown) =>
    emit("shellcanvas-native-extension-progress", { stage, detail });
  await progress("root-started");
  async function channelRoundtrip(size: number) {
    const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
    let receive!: (bytes: number[]) => void;
    const received = new Promise<number[]>((resolve) => {
      receive = resolve;
    });
    const channel = new Channel<number[]>(receive);
    const count = await invoke<number>("channel_roundtrip", { channel, bytes });
    const reply = await received;
    return (
      count === size &&
      reply.length === size &&
      reply.every((value, index) => value === bytes[index])
    );
  }
  const smallChannel = await channelRoundtrip(8);
  const largeChannel = await channelRoundtrip(200_000);
  await progress("native-channels", { smallChannel, largeChannel });
  const token = crypto.randomUUID();
  // A valid desktop call must succeed, so a rejected child call is not just a broken command.
  const control = await invoke<Published>("publish_app_frame", {
    script: "void 0",
    style: "",
    instanceToken: "control",
  });
  const controlReleased = await invoke<boolean>("release_app_frame", {
    id: control.id,
  });
  await progress("control-released", controlReleased);
  const location = await invoke<Published>("publish_app_frame", {
    script: source,
    style: "body{background:rgb(18,52,86)}",
    instanceToken: token,
  });
  const frame = document.createElement("iframe");
  frame.sandbox.add("allow-scripts");
  frame.title = "Unprivileged app probe";
  frame.style.cssText = "width:100%;height:300px;border:0";
  let peer: RpcPeer | undefined;
  let messages = 0;
  const system: SystemAPI = {
    apiVersion: 1,
    dialogs: {
      messageBox: async () => {
        messages++;
        await progress("broker-invoked");
        return "broker-ok";
      },
      openFile: async () => {
        throw new Error("Undeclared handler must not run");
      },
      saveFile: async () => null,
    },
    files: { saveTextAs: async () => null },
  };
  const receive = (event: MessageEvent) => {
    if (event.source === frame.contentWindow)
      void progress("child-message", event.data);
    if (
      event.source !== frame.contentWindow ||
      !isFrameHandshake(event.data, "ready", token) ||
      peer
    )
      return;
    const channel = new MessageChannel();
    const methods = new Map(systemMethods(system));
    methods.set("probe.report", {
      grants: [],
      async invoke(value: Json) {
        const child = value as {
          checks: Record<string, boolean>;
          details: Json;
        };
        const canaryIntact = await invoke<boolean>("release_app_frame", {
          id: location.id,
        });
        const checks = {
          ...child.checks,
          controlReleased,
          canaryIntact,
          smallChannel,
          largeChannel,
          exactlyOneBrokerCall: messages === 1,
        };
        const report = {
          success: Object.values(checks).every((passed) => passed === true),
          checks,
          details: child.details,
          userAgent: navigator.userAgent,
        };
        document.querySelector("#result")!.textContent = JSON.stringify(
          report,
          null,
          2,
        );
        await emit("shellcanvas-native-extension-probe", report);
        return null;
      },
    });
    peer = new RpcPeer(messagePortTransport(channel.port1), methods, [
      "system.dialogs",
    ]);
    frame.contentWindow!.postMessage(
      { type: "shellcanvas:connect:v1", token },
      "*",
      [channel.port2],
    );
    void progress("channel-posted");
  };
  window.addEventListener("message", receive);
  frame.addEventListener("load", () => {
    void progress("frame-loaded");
  });
  frame.src = location.url;
  document.body.append(frame);
  await progress("frame-mounted", location.url);
}
void probe().catch(async (error) => {
  const report = { success: false, error: String(error) };
  document.querySelector("#result")!.textContent = JSON.stringify(report);
  await emit("shellcanvas-native-extension-probe", report);
});
