// SPDX-License-Identifier: MPL-2.0
import { invoke, isTauri } from "@tauri-apps/api/core";
import { appDocument, type AppPackage } from "./package";

/** A late native publication is released even if its React owner has already closed. */
export function mountAppDocument(
  frame: HTMLIFrameElement,
  app: AppPackage,
  token: string,
  failed: (message: string) => void,
): () => void {
  let retired = false;
  let id: string | undefined;
  let browserDocument = false;
  let publication: ReturnType<typeof setTimeout> | undefined;
  const release = (identity: string) => {
    void invoke("release_app_frame", { id: identity }).catch((error) => {
      // The owner has already closed, so avoid updating its React state. Keep failures
      // diagnosable; process teardown also drops the ephemeral resource store.
      console.warn("Unable to release the app document.", error);
    });
  };
  if (isTauri()) {
    void invoke<{ id: string; url: string }>("publish_app_frame", {
      script: app.script,
      style: app.style,
      instanceToken: token,
    })
      .then((location) => {
        if (retired) {
          release(location.id);
          return;
        }
        id = location.id;
        frame.removeAttribute("srcdoc");
        frame.src = location.url;
      })
      .catch((error) => {
        if (!retired) failed(String(error));
      });
  } else {
    // Coalesce synthetic StrictMode setup/cleanup before starting a browser navigation.
    publication = setTimeout(() => {
      if (retired) return;
      browserDocument = true;
      frame.srcdoc = appDocument(app, token);
    }, 0);
  }
  return () => {
    if (retired) return;
    retired = true;
    clearTimeout(publication);
    // Do not enqueue a srcdoc navigation during cleanup: it can complete after
    // the next setup's URL navigation. Unpublished StrictMode setups need no navigation.
    if (id || browserDocument) {
      frame.removeAttribute("srcdoc");
      frame.src = "about:blank";
    }
    if (id) release(id);
  };
}

export function isFrameHandshake(
  value: unknown,
  type: "ready" | "connect",
  token: string,
): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).type === `shellcanvas:${type}:v1` &&
    (value as Record<string, unknown>).token === token
  );
}
