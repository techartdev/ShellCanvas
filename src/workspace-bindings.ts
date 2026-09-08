// SPDX-License-Identifier: MPL-2.0
import { bindSession } from "./session-services";
import { shareFileClipboard } from "./file-clipboard";
import {
  capabilityLabels,
  capabilityStatus,
  type Capability,
  type DesktopApp,
  type HostServices,
  type Session,
} from "./sdk";

export function fileSourceKey(session: Session | null): string {
  return serviceKey(session, ["files.read"]);
}
function serviceKey(
  session: Session | null,
  capabilities: readonly Capability[],
  custom: readonly string[] = [],
): string {
  return JSON.stringify([
    session?.id ?? null,
    [...capabilities]
      .sort()
      .map((cap) => [
        cap,
        session ? (capabilityStatus(session, cap).source ?? null) : null,
      ]),
    [...custom]
      .sort()
      .map((id) => [
        id,
        session?.customSources?.[id] ??
          (session?.customSources ? null : (session?.connections ?? null)),
      ]),
  ]);
}
type Binding = ReturnType<typeof bindSession>;
interface RecordBinding {
  key: string;
  fileKey: string;
  binding: Binding;
}
interface Assignment {
  key: string;
  record: RecordBinding;
}
export interface BindingPlan {
  session: Session | null;
  current: RecordBinding;
  fileOwner: RecordBinding;
  records: Set<RecordBinding>;
  windows: Map<string, Assignment>;
}

/** Window assignments change only when one of that app's selected sources changes.
 * Planning creates inert handles; commit performs lifecycle effects after React renders.
 */
export class WorkspaceBindings {
  private records = new Set<RecordBinding>();
  private current?: RecordBinding;
  private fileOwner?: RecordBinding;
  private windows = new Map<string, Assignment>();
  constructor(
    private backend: HostServices,
    private reportError: (message: string) => void,
  ) {}

  prepare(
    session: Session | null,
    apps: ReadonlyMap<string, DesktopApp>,
  ): BindingPlan {
    const key = JSON.stringify([
      serviceKey(
        session,
        Object.keys(capabilityLabels) as Capability[],
        Object.keys(session?.customSources ?? {}).sort(),
      ),
      session?.customSources ? null : (session?.connections ?? null),
    ]);
    const fileKey = fileSourceKey(session);
    let fileOwner =
      this.fileOwner?.fileKey === fileKey ? this.fileOwner : undefined;
    const current =
      this.current?.key === key
        ? this.current
        : {
            key,
            fileKey,
            binding: bindSession(this.backend, session, this.reportError, {
              clipboardLifecycle: !fileOwner,
            }),
          };
    if (!fileOwner) fileOwner = current;
    else if (fileOwner !== current)
      shareFileClipboard(fileOwner.binding.services, current.binding.services);
    const windows = new Map<string, Assignment>();
    const records = new Set([current, fileOwner]);
    for (const [id, app] of apps) {
      const appKey = serviceKey(
        session,
        [...app.requires, ...(app.optional ?? [])],
        app.customPermissions?.map((grant) => grant.replace(/^services\./, "")),
      );
      const previous = this.windows.get(id);
      const assignment =
        previous?.key === appKey ? previous : { key: appKey, record: current };
      windows.set(id, assignment);
      records.add(assignment.record);
    }
    return { session, current, fileOwner, windows, records };
  }
  commit(plan: BindingPlan, connected: boolean) {
    for (const record of plan.records) {
      record.binding.updateAvailability(plan.session);
      if (connected) record.binding.activate();
      else record.binding.dispose();
    }
    for (const record of this.records) {
      if (!plan.records.has(record)) record.binding.dispose();
    }
    this.records = plan.records;
    this.current = plan.current;
    this.fileOwner = plan.fileOwner;
    this.windows = plan.windows;
  }
  dispose() {
    for (const record of this.records) record.binding.dispose();
  }
}
