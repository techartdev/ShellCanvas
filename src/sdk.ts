// SPDX-License-Identifier: MPL-2.0
import type { ComponentType } from "react";
export type Capability = "terminal" | "files.read";
export interface HostProfile {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  keyPath: string;
}
export interface ConnectOptions extends Omit<HostProfile, "name" | "id"> {
  password?: string;
  passphrase?: string;
}
export interface HostInfo {
  provider: string;
  system: string;
  hostname: string;
  home: string | null;
  capabilities: Capability[];
  notices: string[];
}
export interface Session {
  id: number;
  info: HostInfo;
}
export interface FileEntry {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink";
  size: number;
  modified: number | null;
}
export interface Directory {
  path: string;
  entries: FileEntry[];
}
export type TerminalEvent =
  | { type: "output"; data: number[] }
  | { type: "closed" }
  | { type: "error"; data: string };
export interface TerminalSession {
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}
export interface HostServices {
  profiles(): Promise<HostProfile[]>;
  saveProfile(profile: HostProfile): Promise<HostProfile>;
  removeProfile(id: string): Promise<void>;
  connect(options: ConnectOptions): Promise<Session>;
  disconnect(sessionId: number): Promise<void>;
  alive(sessionId: number): Promise<boolean>;
  list(sessionId: number, path: string): Promise<Directory>;
  preview(sessionId: number, path: string): Promise<string>;
  terminal(
    sessionId: number,
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<TerminalSession>;
}
/** Apps receive a fixed session handle, never connection administration. */
export interface SessionServices {
  list(path: string): Promise<Directory>;
  preview(path: string): Promise<string>;
  terminal(
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<TerminalSession>;
}
export interface AppContext {
  session: Session | null;
  services: SessionServices;
  active?: boolean;
  preview: boolean;
  connect(): void;
  reportError(message: string): void;
}
export interface DesktopApp {
  /** Bundled SDK version, not a runtime permission or compatibility guarantee. */
  apiVersion: 1;
  id: string;
  title: string;
  subtitle: string;
  scope: "host" | "local";
  requires: Capability[];
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  component: ComponentType<AppContext>;
  window?: {
    layout?: "primary" | "secondary" | "standard";
    openOnStart?: boolean;
  };
}

/** Validate trusted bundled modules at startup, before rendering the desktop. */
export function defineApps(definitions: DesktopApp[]): readonly DesktopApp[] {
  const ids = new Set<string>();
  return Object.freeze(
    definitions.map((app) => {
      if (app.apiVersion !== 1)
        throw new Error(`Unsupported app API: ${app.id}`);
      if (!/^[a-z][a-z0-9.-]*$/.test(app.id) || ids.has(app.id))
        throw new Error(`Invalid or duplicate app ID: ${app.id}`);
      if (!app.title.trim())
        throw new Error(`App title is required: ${app.id}`);
      if (app.scope !== "host" && app.scope !== "local")
        throw new Error(`Invalid app scope: ${app.id}`);
      if (
        app.requires.some((cap) => cap !== "terminal" && cap !== "files.read")
      )
        throw new Error(`Unknown app capability: ${app.id}`);
      if (app.scope === "local" && app.requires.length)
        throw new Error(
          `Local apps cannot require host capabilities: ${app.id}`,
        );
      if (
        app.window?.layout &&
        !["primary", "secondary", "standard"].includes(app.window.layout)
      )
        throw new Error(`Invalid window layout: ${app.id}`);
      ids.add(app.id);
      return { ...app, requires: [...app.requires], window: { ...app.window } };
    }),
  );
}
export function unavailableReason(
  app: DesktopApp,
  session: Session | null,
): string | null {
  if (app.scope === "host" && !session) return "Connect a host to get started";
  const missing = app.requires.filter(
    (cap) => !session?.info.capabilities.includes(cap),
  );
  return missing.length
    ? `Unavailable on this device: ${missing.map((cap) => (cap === "files.read" ? "file browsing" : "terminal")).join(", ")}`
    : null;
}
