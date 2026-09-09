// SPDX-License-Identifier: MPL-2.0
export interface AppDocumentState {
  dirty: boolean;
  busy: boolean;
  title?: string;
}
export interface AppWindowState {
  visible: boolean;
  focused: boolean;
  mode: "normal" | "maximized" | "tiled-left" | "tiled-right";
  canMaximize: boolean;
}
/** Controls affect only the calling app window, never another workspace. */
export interface AppWindowAPI {
  setDocumentState(state: AppDocumentState): Promise<void>;
  getState(signal?: AbortSignal): Promise<AppWindowState>;
  focus(signal?: AbortSignal): Promise<void>;
  minimize(signal?: AbortSignal): Promise<void>;
  maximize(signal?: AbortSignal): Promise<void>;
  restore(signal?: AbortSignal): Promise<void>;
  /** Requests normal guarded close. Save first; the app may be destroyed before a reply arrives. */
  requestClose(signal?: AbortSignal): Promise<void>;
}
