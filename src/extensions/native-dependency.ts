// SPDX-License-Identifier: MPL-2.0
import type { AdapterInfo, AdapterReview, AdapterServices } from "../adapters";
import type { AppCatalog, InstallReview, InstalledApp } from "./catalog";

export interface NativeDependencyReview {
  readonly review: AdapterReview;
  readonly mode: "install" | "reuse" | "replace";
}

export function resolveNativeDependency(
  appId: string,
  reviewed: AdapterReview,
  adapters: readonly AdapterInfo[],
  apps: readonly InstalledApp[],
): NativeDependencyReview {
  const proposed = reviewed.package;
  const conflicts = apps.filter(
    (app) =>
      app.package.id !== appId &&
      app.nativeAdapter?.id === proposed.id &&
      app.nativeAdapter.digest !== proposed.digest,
  );
  if (conflicts.length)
    throw new Error(
      `${conflicts[0].package.title} requires a different ${proposed.name} package. Resolve the shared native adapter conflict first.`,
    );
  const installed = adapters.find((adapter) => adapter.id === proposed.id);
  if (!installed) {
    if (reviewed.replaces)
      throw new Error("The native adapter catalog changed during review.");
    return { review: reviewed, mode: "install" };
  }
  if (installed.digest === proposed.digest) {
    if (!installed.enabled)
      throw new Error(
        `${installed.name} is installed but disabled. Enable it under Connection adapters, then review this app again.`,
      );
    return { review: reviewed, mode: "reuse" };
  }
  const current = apps.find((app) => app.package.id === appId)?.nativeAdapter;
  if (
    !reviewed.replaces ||
    current?.id !== installed.id ||
    current.digest !== installed.digest
  )
    throw new Error(
      `${installed.name} is already installed from another or older source. Review it under Connection adapters before installing this app.`,
    );
  return { review: reviewed, mode: "replace" };
}

export async function installWithNativeDependency(
  catalog: AppCatalog,
  review: InstallReview,
  grants: readonly string[],
  adapters: AdapterServices,
  native: NativeDependencyReview,
) {
  if (!adapters.installDependency)
    throw new Error("This desktop cannot install native app components.");
  const installed = await catalog.install(review, grants);
  try {
    await adapters.installDependency(
      native.review.requestId,
      native.mode === "reuse",
    );
    return installed;
  } catch (nativeError) {
    try {
      await catalog.rollbackInstall(installed, review.replaces);
    } catch (rollbackError) {
      throw new Error(
        `The native component was not installed, and the app changed before it could be rolled back. Manage the app and adapter separately. Native error: ${String(nativeError)}. Rollback error: ${String(rollbackError)}`,
      );
    }
    throw new Error(
      `The native component was not installed, so the app installation was rolled back. ${String(nativeError)}`,
    );
  }
}
