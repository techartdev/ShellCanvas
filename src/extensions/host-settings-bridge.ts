// SPDX-License-Identifier: MPL-2.0
import type { HostSetting, SessionServices } from "../sdk";
import { RpcError, type Json, type RpcMethod } from "./rpc";

export interface AppHostSettingsSource {
  binding: string;
  services: Pick<SessionServices, "readHostSettings" | "applyHostSetting">;
}
export type AppHostSettingsSourceGetter = () =>
  AppHostSettingsSource | undefined;

function parameters(value: Json, fields: string[]): Record<string, string> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some(
      (field) =>
        typeof value[field] !== "string" ||
        (field !== "value" && !value[field]),
    )
  )
    throw new RpcError(
      "invalid",
      "Supply the accepted binding and documented setting parameters, including a revision for changes.",
    );
  return value as Record<string, string>;
}
function exposed(setting: HostSetting, binding: string): Json {
  // Do not publish extra provider fields or native identifiers.
  return {
    binding,
    id: setting.id,
    label: setting.label,
    description: setting.description,
    value: setting.value,
    revision: setting.revision,
    editor: setting.editor,
    choices: [...setting.choices],
    writable: setting.writable,
    reason: setting.reason,
  };
}

/** One window's settings operations; canceled native work stays charged until settled. */
export class AppHostSettings {
  private closed = false;
  private reading = false;
  private writing = false;
  constructor(
    private source: AppHostSettingsSourceGetter,
    private available: () => boolean,
    private busyChanged: (busy: boolean) => void = () => {},
  ) {}
  close() {
    this.closed = true;
  }
  private same(captured: AppHostSettingsSource) {
    const current = this.source();
    return (
      !this.closed &&
      this.available() &&
      current?.binding === captured.binding &&
      current.services === captured.services
    );
  }
  methods(): ReadonlyMap<string, RpcMethod> {
    const method = (write: boolean): RpcMethod => ({
      grants: [write ? "host.settings.write" : "host.settings.read"],
      available: () => !this.closed && this.available(),
      invoke: async (value, signal) => {
        const p = parameters(
          value,
          write ? ["binding", "id", "revision", "value"] : ["binding"],
        );
        if (this.closed)
          throw new RpcError("closed", "Settings window has closed.");
        if (!this.available())
          throw new RpcError(
            "unavailable",
            "Remote settings are unavailable on this connection.",
          );
        const captured = this.source();
        if (!captured)
          throw new RpcError(
            "unavailable",
            "No remote settings source in this workspace.",
          );
        if (captured.binding !== p.binding)
          throw new RpcError(
            "closed",
            "This setting belongs to a previous connection. Refresh settings after accepting the current connection.",
          );
        if (signal.aborted)
          throw new RpcError(
            "aborted",
            "Settings request canceled before dispatch.",
          );
        if (write ? this.writing : this.reading)
          throw new RpcError(
            "busy",
            "Wait for the previous settings operation to finish.",
          );
        if (write) {
          this.writing = true;
          this.busyChanged(true);
        } else this.reading = true;
        try {
          const result = write
            ? await captured.services.applyHostSetting(
                p.id,
                p.value,
                p.revision,
              )
            : await captured.services.readHostSettings();
          if (signal.aborted || !this.same(captured))
            throw new RpcError(
              signal.aborted ? "aborted" : "closed",
              write
                ? "The settings operation ended after cancellation or a connection change. It may have been applied; refresh before retrying."
                : "The settings read ended after cancellation or a connection change. Refresh on the accepted connection.",
            );
          return Array.isArray(result)
            ? result.map((setting) => exposed(setting, captured.binding))
            : exposed(result, captured.binding);
        } catch (error) {
          if (error instanceof RpcError) throw error;
          const message =
            error instanceof Error
              ? error.message
              : typeof error === "string"
                ? error
                : "Remote settings operation failed.";
          throw new RpcError("failed", message.slice(0, 4096));
        } finally {
          if (write) {
            this.writing = false;
            this.busyChanged(false);
          } else this.reading = false;
        }
      },
    });
    return new Map([
      ["system.hostSettings.read", method(false)],
      ["system.hostSettings.apply", method(true)],
    ]);
  }
}
