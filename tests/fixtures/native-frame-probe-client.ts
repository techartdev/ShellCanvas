// SPDX-License-Identifier: MPL-2.0
import { connectToShellCanvas } from "../../src/extensions/client";
async function probe() {
  parent.postMessage({ diagnostic: "child-started" }, "*");
  // This must not acquire a channel, even though it comes from the assigned iframe window.
  parent.postMessage(
    { type: "shellcanvas:ready:v1", token: "stale-document" },
    "*",
  );
  const client = await connectToShellCanvas();
  parent.postMessage({ diagnostic: "child-connected" }, "*");
  const checks: Record<string, boolean> = {};
  const details: Record<string, unknown> = {};
  checks.broker =
    (await client.system.dialogs.messageBox({
      title: "Probe",
      message: "Broker call",
    })) === "broker-ok";
  parent.postMessage({ diagnostic: "broker-returned" }, "*");
  try {
    await client.system.dialogs.openFile();
    checks.undeclaredDenied = false;
  } catch (error) {
    checks.undeclaredDenied = (error as { code?: string }).code === "denied";
  }
  try {
    void parent.document;
    checks.parentDomBlocked = false;
  } catch {
    checks.parentDomBlocked = true;
  }
  try {
    void localStorage.length;
    checks.localStorageBlocked = false;
  } catch {
    checks.localStorageBlocked = true;
  }
  checks.stylesApplied =
    getComputedStyle(document.body).backgroundColor === "rgb(18, 52, 86)";
  const environment = window as unknown as {
    __TAURI_INTERNALS__?: {
      invoke?: (command: string, args: unknown) => Promise<unknown>;
      ipc?: unknown;
      postMessage?: unknown;
    };
    ipc?: { postMessage: (message: string) => void };
    chrome?: { webview?: { postMessage: (message: string) => void } };
  };
  // API wrappers may exist; ShellCanvas must withhold the closure containing the native key.
  checks.noNativeTransport = !environment.__TAURI_INTERNALS__?.postMessage;
  details.nativeWrapperPresent = !!environment.__TAURI_INTERNALS__?.invoke;
  parent.postMessage({ diagnostic: "isolation-checked", checks }, "*");
  const id = location.pathname.split("/")[1];
  const raw = JSON.stringify({
    cmd: "release_app_frame",
    callback: 4294900001,
    error: 4294900002,
    payload: { id },
    options: {},
    __TAURI_INVOKE_KEY__: "not-the-native-invoke-key",
  });
  const attempts: string[] = [];
  if (environment.ipc) {
    attempts.push("window.ipc");
    try {
      environment.ipc.postMessage(raw);
    } catch {}
  }
  if (environment.chrome?.webview) {
    attempts.push("chrome.webview");
    try {
      environment.chrome.webview.postMessage(raw);
    } catch {}
  }
  if (environment.__TAURI_INTERNALS__?.invoke) {
    attempts.push("native-internals");
    // An unavailable IPC wrapper queues indefinitely; don't let that stall the negative test.
    void environment.__TAURI_INTERNALS__
      .invoke("release_app_frame", { id })
      .catch(() => {});
  }
  try {
    await fetch("http://ipc.localhost/release_app_frame", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Tauri-Invoke-Key": "invalid",
        "Tauri-Callback": "4294900001",
        "Tauri-Error": "4294900002",
      },
      body: JSON.stringify({ id }),
    });
    checks.ipcFetchBlocked = false;
  } catch {
    checks.ipcFetchBlocked = true;
  }
  try {
    window.top!.location.href = location.href;
    checks.topNavigationBlocked = false;
  } catch {
    checks.topNavigationBlocked = true;
  }
  details.directNativeAttempts = attempts;
  parent.postMessage({ diagnostic: "native-attempts-finished", checks }, "*");
  // Let the native event queue process attempted canary deletions before the parent checks it.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await client.call("probe.report", { checks, details } as Parameters<
    typeof client.call
  >[1]);
}
void probe().catch((error) => {
  parent.postMessage({ diagnostic: "child-failed", error: String(error) }, "*");
  document.body.textContent = `Probe failed: ${String(error)}`;
});
