// SPDX-License-Identifier: MPL-2.0
import type { FileEntry, TextDocument } from "../packages/app-sdk/src/files";
import type { HostSetting } from "../packages/app-sdk/src/host-settings-client";
export type { HostSetting } from "../packages/app-sdk/src/host-settings-client";
import type { ComponentType } from "react";
import type { SystemAPI } from "./system-api";
export type {
  SystemAPI,
  SystemDialogs,
  MessageBoxOptions,
  OpenFileOptions,
  SaveFileOptions,
  FileSaveSelection,
  DialogControl,
} from "./system-api";
export type Capability =
  | "terminal"
  | "files.read"
  | "files.edit"
  | "files.create"
  | "files.manage"
  | "files.move"
  | "files.copy"
  | "files.folders"
  | "files.upload"
  | "files.download"
  | "host.settings";
export const capabilityLabels: Record<Capability, string> = {
  terminal: "Terminal",
  "files.read": "File browsing",
  "files.edit": "Text editing",
  "files.create": "New text files",
  "files.manage": "File changes",
  "files.move": "Move files and folders",
  "files.copy": "Copy files",
  "files.folders": "Transfer folders",
  "files.upload": "Uploads",
  "files.download": "Downloads",
  "host.settings": "Remote settings",
};
export interface TransferTicket {
  id: number;
  name: string;
  size: number;
  direction: "upload" | "download" | "copy" | "move";
}
export function transferCapability(
  direction: TransferTicket["direction"],
): Capability {
  return direction === "move"
    ? "files.move"
    : direction === "copy"
      ? "files.copy"
      : direction === "upload"
        ? "files.upload"
        : "files.download";
}
export interface TransferProgress {
  bytes: number;
  total: number;
  items?: number;
  phase: "preparing" | "running" | "finishing";
}
export interface TransferOutcome {
  status: "completed" | "canceled" | "failed";
  bytes: number;
  total: number;
  message?: string | null;
  path?: string | null;
  relocation?: FileRelocation;
}
export type { TextDocument } from "../packages/app-sdk/src/files";
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
export interface ConnectionIdentity {
  instance: number;
  generation: number;
  adapter: string;
}
export interface Session {
  sourceRevision?: number;
  id: number;
  info: HostInfo;
  /** Established connector identities; absent in older/synthetic backends. Not a trust claim. */
  connections?: readonly ConnectionIdentity[];
  /** Complete capability snapshot when supplied by the backend. */
  services?: readonly ServiceStatus[];
  /** Selected custom-service sources, independently of current availability. */
  customSources?: Readonly<Record<string, ConnectionIdentity>>;
}
export interface ServiceStatus {
  capability: Capability;
  state: "available" | "unsupported" | "checking" | "disconnected" | "denied";
  reason?: string | null;
  source?: ConnectionIdentity | null;
  /** Optional operation support within this capability; absent means a legacy provider. */
  operations?: readonly string[];
}
export interface WorkspaceStatus {
  sourceRevision?: number;
  connected: boolean;
  services: readonly ServiceStatus[];
  customSources?: Readonly<Record<string, ConnectionIdentity>>;
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
export type { FileEntry } from "../packages/app-sdk/src/files";
export function capabilityOperationReason(
  session: Session,
  capability: Capability,
  operation: string,
): string | null {
  const unavailable = capabilityReason(session, capability);
  if (unavailable) return unavailable;
  const operations = capabilityStatus(session, capability).operations;
  return operations && !operations.includes(operation)
    ? `This device does not provide ${operation === "readText" ? "text documents" : operation}.`
    : null;
}
export interface FilePlace {
  path: string;
  name: string;
}
export interface FileVolume {
  id: string;
  name: string;
  detail: string;
  locations: FilePlace[];
  system: boolean;
  canMount: boolean;
  canUnmount: boolean;
}
export interface FileVolumes {
  revision: string;
  volumes: FileVolume[];
  notices: string[];
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
export interface DirectoryPage {
  directory: Directory;
  done: boolean;
}
export interface DirectoryReader {
  next(signal?: AbortSignal): Promise<DirectoryPage>;
  close(): Promise<void>;
}
export type TerminalEvent =
  | { type: "output"; data: number[] }
  | { type: "closed" }
  | { type: "error"; data: string };
export interface TerminalSession {
  /** Absent only for legacy bundled providers. */
  readonly resizable?: boolean;
  write(data: string | Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}
export interface ClipboardPreparation {
  id: string;
  onProgress?: (progress: TransferProgress) => void;
}
export interface ClipboardFileState {
  kind: "local" | "remote" | "empty";
  sequence: number;
  intent?: "copy" | "move";
}
export interface DriveMappingAvailability {
  supported: boolean;
  installed: boolean;
  windows: boolean;
  availableDrives?: string[];
}
export interface HostServices {
  driveMappingAvailable?(sessionId: number): Promise<DriveMappingAvailability>;
  attachDrive?(
    sessionId: number,
    path: string,
    writable: boolean,
    drive?: string,
    hostLabel?: string,
  ): Promise<string | null>;
  volumes?(sessionId: number): Promise<FileVolumes>;
  setVolumeMounted?(
    sessionId: number,
    id: string,
    revision: string,
    mounted: boolean,
  ): Promise<void>;
  cancelSystemCut?(sessionId: number, sequence: number): Promise<void>;
  pasteMovedFiles?(
    sessionId: number,
    parent: string,
    sequence: number,
  ): Promise<TransferTicket[]>;
  inspectSystemFiles?(): Promise<ClipboardFileState>;
  pasteCopiedFiles?(
    sessionId: number,
    parent: string,
    sequence: number,
  ): Promise<TransferTicket[]>;
  prepareCopySelection?(
    sessionId: number,
    files: { path: string; revision: string }[],
    parent: string,
  ): Promise<TransferTicket>;
  /** Capture native source identities once; never follow a later source replacement. */
  bindSources?(session: Session): HostServices;
  custom?: import("./custom-services").CustomBackend;
  cancelClipboardPreparation(
    sessionId: number,
    operation: string,
  ): Promise<void>;
  systemClipboardSequence(): Promise<number>;
  pasteSystemFiles(
    sessionId: number,
    parent: string,
    sequence?: number,
  ): Promise<TransferTicket[] | null>;
  cutToSystem(
    sessionId: number,
    path: string,
    revision: string,
    preparation?: ClipboardPreparation,
    exportContents?: boolean,
  ): Promise<number>;
  systemFileClipboard?: boolean;
  copyToSystem(
    sessionId: number,
    files: { path: string; revision: string }[],
    preparation?: ClipboardPreparation,
  ): Promise<number>;
  chooseDownloads(
    sessionId: number,
    files: { path: string; revision: string }[],
  ): Promise<TransferTicket[]>;
  prepareCopy(
    sessionId: number,
    path: string,
    revision: string,
    parent: string,
  ): Promise<TransferTicket>;
  readHostSettings(sessionId: number): Promise<HostSetting[]>;
  applyHostSetting(
    sessionId: number,
    id: string,
    value: string,
    revision: string,
  ): Promise<HostSetting>;
  chooseUploads(
    sessionId: number,
    parent: string,
    folder?: boolean,
  ): Promise<TransferTicket[]>;
  chooseDownload(
    sessionId: number,
    path: string,
    revision: string,
  ): Promise<TransferTicket | null>;
  runTransfer(
    sessionId: number,
    id: number,
    onProgress: (event: TransferProgress) => void,
    tracked?: string[],
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
  openDirectory?(
    sessionId: number,
    path?: string,
    signal?: AbortSignal,
  ): Promise<DirectoryReader>;
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
    onEvent: (event: TerminalEvent) => void | Promise<void>,
  ): Promise<TerminalSession>;
}
/** Apps receive a fixed session handle, never connection administration. */
export interface SessionServices {
  driveMappingAvailable?(): Promise<DriveMappingAvailability>;
  attachDrive?(
    path: string,
    writable: boolean,
    drive?: string,
  ): Promise<string | null>;
  volumes?(): Promise<FileVolumes>;
  setVolumeMounted?(
    id: string,
    revision: string,
    mounted: boolean,
  ): Promise<void>;
  cancelSystemCut?(sequence: number): Promise<void>;
  pasteMovedFiles?(parent: string, sequence: number): Promise<TransferTicket[]>;
  inspectSystemFiles?(): Promise<ClipboardFileState>;
  pasteCopiedFiles?(
    parent: string,
    sequence: number,
  ): Promise<TransferTicket[]>;
  prepareCopySelection?(
    files: { path: string; revision: string }[],
    parent: string,
  ): Promise<TransferTicket>;
  custom?: import("./custom-services").CustomAccess;
  cancelClipboardPreparation(operation: string): Promise<void>;
  systemClipboardSequence(): Promise<number>;
  pasteSystemFiles(
    parent: string,
    sequence?: number,
  ): Promise<TransferTicket[] | null>;
  cutToSystem(
    path: string,
    revision: string,
    preparation?: ClipboardPreparation,
    exportContents?: boolean,
  ): Promise<number>;
  systemFileClipboard?: boolean;
  copyToSystem(
    files: { path: string; revision: string }[],
    preparation?: ClipboardPreparation,
  ): Promise<number>;
  chooseDownloads(
    files: { path: string; revision: string }[],
  ): Promise<TransferTicket[]>;
  prepareCopy(
    path: string,
    revision: string,
    parent: string,
  ): Promise<TransferTicket>;
  readHostSettings(): Promise<HostSetting[]>;
  applyHostSetting(
    id: string,
    value: string,
    revision: string,
  ): Promise<HostSetting>;
  chooseUploads(parent: string, folder?: boolean): Promise<TransferTicket[]>;
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
  openDirectory?(path?: string, signal?: AbortSignal): Promise<DirectoryReader>;
  preview(path: string): Promise<string>;
  readText(path: string): Promise<TextDocument>;
  saveText(path: string, text: string, revision: string): Promise<TextDocument>;
  terminal(
    cols: number,
    rows: number,
    onEvent: (event: TerminalEvent) => void | Promise<void>,
  ): Promise<TerminalSession>;
}
export interface AppContext {
  /** Stable configured target identity; never a service routing token. */
  workspaceId?: string | null;
  /** User-facing workspace name and non-secret target description. */
  workspaceLabel?: string;
  workspaceTarget?: string;
  /** Host-owned controls scoped to this window. */
  window?: import("./extensions/window-api").WindowControls;
  /** True only when this window is visible in the current workspace. */
  visible?: boolean;
  /** Supplied by the desktop window. Optional only for legacy standalone embeds. */
  system?: SystemAPI;
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
  /** Custom service grants used by trusted bundled apps and installed app descriptors. */
  customPermissions?: readonly string[];
  /** Bundled SDK version, not a runtime permission or compatibility guarantee. */
  apiVersion: 1;
  id: string;
  title: string;
  subtitle: string;
  scope: "host" | "local";
  /** Host-aware UI that can also work locally; required host capabilities still gate it. */
  allowWithoutHost?: boolean;
  requires: readonly Capability[];
  /** Services the app may use when available, without blocking startup. */
  optional?: readonly Capability[];
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  /** Packaged artwork (data URI). Listings fall back to `icon` when absent or unreadable. */
  image?: string;
  /** Listing text for installed apps, whose subtitle identifies the running version. */
  description?: string;
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
              "files.copy",
              "files.folders",
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
  if (
    app.scope === "host" &&
    !session &&
    (!app.allowWithoutHost || app.requires.length)
  )
    return "Connect a host to get started";
  return session
    ? app.requires
        .map((cap) => capabilityReason(session, cap))
        .filter(Boolean)
        .join("; ") || null
    : null;
}
