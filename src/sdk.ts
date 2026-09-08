// SPDX-License-Identifier: MPL-2.0
import type { ComponentType } from "react";
export type Capability =
  | "terminal"
  | "files.read"
  | "files.edit"
  | "files.create"
  | "files.manage"
  | "files.move"
  | "files.upload"
  | "files.download"
  | "host.settings";
export interface HostSetting {
  id: string;
  label: string;
  description: string;
  value: string | null;
  revision: string | null;
  editor: "text" | "select";
  choices: string[];
  writable: boolean;
  reason: string | null;
}
export const capabilityLabels: Record<Capability, string> = {
  terminal: "Terminal",
  "files.read": "File browsing",
  "files.edit": "Text editing",
  "files.create": "New text files",
  "files.manage": "File changes",
  "files.move": "Move files and folders",
  "files.upload": "Uploads",
  "files.download": "Downloads",
  "host.settings": "Remote settings",
};
export interface TransferTicket {
  id: number;
  name: string;
  size: number;
  direction: "upload" | "download";
}
export interface TransferProgress {
  bytes: number;
  total: number;
  phase: "preparing" | "running" | "finishing";
}
export interface TransferOutcome {
  status: "completed" | "canceled" | "failed";
  bytes: number;
  total: number;
  message?: string | null;
  path?: string | null;
}
export interface TextDocument {
  path: string;
  name: string;
  parent: string | null;
  text: string;
  revision: string;
  writable: boolean;
}
export interface FileLocation {
  path: string;
  name: string;
  parent: string | null;
}
export interface FileRelocation {
  path: string;
  locations: { previous: string; location: FileLocation }[];
}
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
export interface HostKeyChallenge {
  token: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
}
export type HostKeyReviewer = (challenge: HostKeyChallenge) => Promise<boolean>;
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
  /** Established connector identities; absent in older/synthetic backends. Not a trust claim. */
  connections?: readonly {
    instance: number;
    generation: number;
    adapter: string;
  }[];
  /** Complete capability snapshot when supplied by the backend. */
  services?: readonly ServiceStatus[];
}
export interface ServiceStatus {
  capability: Capability;
  state: "available" | "unsupported" | "checking" | "disconnected" | "denied";
  reason?: string | null;
  source?: { instance: number; generation: number; adapter: string } | null;
}
export interface WorkspaceStatus {
  connected: boolean;
  services: readonly ServiceStatus[];
}
export function capabilityStatus(
  session: Session,
  capability: Capability,
): ServiceStatus {
  return (
    session.services?.find((item) => item.capability === capability) ?? {
      capability,
      state:
        !session.services && session.info.capabilities.includes(capability)
          ? "available"
          : "unsupported",
    }
  );
}
export function capabilityReason(
  session: Session,
  capability: Capability,
): string | null {
  const status = capabilityStatus(session, capability);
  return status.state === "available"
    ? null
    : `Unavailable ${capabilityLabels[capability].toLowerCase()}: ${status.reason || status.state}`;
}
export interface FileEntry {
  revision?: string;
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink";
  size: number;
  modified: number | null;
}
export interface FilePlace {
  path: string;
  name: string;
}
/** Paths are opaque provider-owned tokens; apps must not split or join them. */
export interface Directory {
  path: string;
  name: string;
  parent: string | null;
  home: FilePlace | null;
  roots: FilePlace[];
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
  readHostSettings(sessionId: number): Promise<HostSetting[]>;
  applyHostSetting(
    sessionId: number,
    id: string,
    value: string,
    revision: string,
  ): Promise<HostSetting>;
  chooseUploads(sessionId: number, parent: string): Promise<TransferTicket[]>;
  chooseDownload(
    sessionId: number,
    path: string,
    revision: string,
  ): Promise<TransferTicket | null>;
  runTransfer(
    sessionId: number,
    id: number,
    onProgress: (event: TransferProgress) => void,
  ): Promise<TransferOutcome>;
  cancelTransfer(sessionId: number, id: number): Promise<void>;
  createText(
    sessionId: number,
    parent: string,
    name: string,
    text: string,
  ): Promise<TextDocument>;
  makeDirectory(
    sessionId: number,
    parent: string,
    name: string,
  ): Promise<string>;
  renameEntry(
    sessionId: number,
    path: string,
    name: string,
    revision: string,
    tracked: string[],
  ): Promise<FileRelocation>;
  removeEntry(sessionId: number, path: string, revision: string): Promise<void>;
  moveEntry(
    sessionId: number,
    path: string,
    parent: string,
    revision: string,
    tracked: string[],
  ): Promise<FileRelocation>;
  profiles(): Promise<HostProfile[]>;
  saveProfile(profile: HostProfile): Promise<HostProfile>;
  removeProfile(id: string): Promise<void>;
  connect(
    options: ConnectOptions,
    signal?: AbortSignal,
    reviewHostKey?: HostKeyReviewer,
  ): Promise<Session>;
  disconnect(sessionId: number): Promise<void>;
  alive(sessionId: number): Promise<boolean>;
  status?(sessionId: number): Promise<WorkspaceStatus | null>;
  list(sessionId: number, path?: string): Promise<Directory>;
  preview(sessionId: number, path: string): Promise<string>;
  readText(sessionId: number, path: string): Promise<TextDocument>;
  saveText(
    sessionId: number,
    path: string,
    text: string,
    revision: string,
  ): Promise<TextDocument>;
  terminal(
    sessionId: number,
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<TerminalSession>;
}
/** Apps receive a fixed session handle, never connection administration. */
export interface SessionServices {
  readHostSettings(): Promise<HostSetting[]>;
  applyHostSetting(
    id: string,
    value: string,
    revision: string,
  ): Promise<HostSetting>;
  chooseUploads(parent: string): Promise<TransferTicket[]>;
  chooseDownload(
    path: string,
    revision: string,
  ): Promise<TransferTicket | null>;
  runTransfer(
    ticket: TransferTicket,
    onProgress: (event: TransferProgress) => void,
  ): Promise<TransferOutcome>;
  cancelTransfer(id: number): Promise<void>;
  createText(parent: string, name: string, text: string): Promise<TextDocument>;
  makeDirectory(parent: string, name: string): Promise<string>;
  renameEntry(path: string, name: string, revision: string): Promise<string>;
  removeEntry(path: string, revision: string): Promise<void>;
  moveEntry(path: string, parent: string, revision: string): Promise<string>;
  list(path?: string): Promise<Directory>;
  preview(path: string): Promise<string>;
  readText(path: string): Promise<TextDocument>;
  saveText(path: string, text: string, revision: string): Promise<TextDocument>;
  terminal(
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void,
  ): Promise<TerminalSession>;
}
export interface AppContext {
  unavailableReason?: string;
  connected?: boolean;
  setDocumentState?(state: {
    dirty: boolean;
    busy: boolean;
    title?: string;
  }): void;
  launch?: { path?: string; directory?: string };
  openApp?(appId: string, launch?: { path?: string; directory?: string }): void;
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
  requires: readonly Capability[];
  /** Services the app may use when available, without blocking startup. */
  optional?: readonly Capability[];
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  component: ComponentType<AppContext>;
  window?: {
    layout?: "primary" | "secondary" | "standard";
    openOnStart?: boolean;
    multiple?: boolean;
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
        [...app.requires, ...(app.optional ?? [])].some(
          (cap) =>
            ![
              "terminal",
              "files.read",
              "files.edit",
              "files.create",
              "files.manage",
              "files.move",
              "files.upload",
              "files.download",
              "host.settings",
            ].includes(cap),
        )
      )
        throw new Error(`Unknown app capability: ${app.id}`);
      const declared = [...app.requires, ...(app.optional ?? [])];
      if (new Set(declared).size !== declared.length)
        throw new Error(`Duplicate app capability: ${app.id}`);
      if (app.scope === "local" && declared.length)
        throw new Error(
          `Local apps cannot require host capabilities: ${app.id}`,
        );
      if (
        app.window?.layout &&
        !["primary", "secondary", "standard"].includes(app.window.layout)
      )
        throw new Error(`Invalid window layout: ${app.id}`);
      ids.add(app.id);
      return Object.freeze({
        ...app,
        requires: Object.freeze([...app.requires]),
        optional: Object.freeze([...(app.optional ?? [])]),
        window: Object.freeze({ ...app.window }),
      });
    }),
  );
}
export function unavailableReason(
  app: DesktopApp,
  session: Session | null,
): string | null {
  if (app.scope === "host" && !session) return "Connect a host to get started";
  return session
    ? app.requires
        .map((cap) => capabilityReason(session, cap))
        .filter(Boolean)
        .join("; ") || null
    : null;
}
