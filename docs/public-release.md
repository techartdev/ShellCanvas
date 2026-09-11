# Public release and package publishing

This repository publishes the Windows desktop through GitHub Releases, the TypeScript app SDK through npm, and the Rust adapter/filesystem SDKs through crates.io. These are the package channels that match the current implementation. Store submissions and additional package managers can follow after platform validation and signing are in place.

## Release preparation

1. Update the version in `package.json`, `packages/app-sdk/package.json`, the publishable crate manifests and `src-tauri/tauri.conf.json`.
2. Update `CHANGELOG.md` and confirm the README's platform boundaries.
3. Run `npm ci`, `npm run verify`, `npm run verify:sdk`, `npm run verify:adapter-sdk`, `cargo package --locked` for each published crate, and `npm pack --workspace @techartdev/shellcanvas-app-sdk --dry-run`.
4. Build the Windows installers with `npm run tauri -- build --bundles nsis,msi`. Install and launch both formats on disposable Windows test environments before release.
5. Create and push an annotated `vX.Y.Z` tag only from a clean, reviewed commit. The release workflow attaches installers and SHA-256 checksums.

The current installer pipeline does not apply Authenticode signing. Windows may warn about an unknown publisher. Add a protected Windows signing certificate before calling the desktop broadly trusted. Do not store certificate material in Git or workflow files.

## SDK registries

`@techartdev/shellcanvas-app-sdk` is a public scoped npm package. The first publish needs the `techartdev` npm account and a current two-factor authentication code. After that, configure npm trusted publishing for `techartdev/ShellCanvas` and `publish-sdks.yml`; OIDC then avoids a long-lived npm token and supplies provenance from the public repository.

`shellcanvas-adapter-sdk` and `shellcanvas-filesystem-sdk` publish to crates.io. The workflow uses a protected `CARGO_REGISTRY_TOKEN` secret. Keep the token out of local files and logs. Publish the filesystem SDK first if the adapter SDK later depends on it.

Registry releases are immutable. Inspect every `npm pack --dry-run` and `cargo package --list` result before publishing, then verify the public registry metadata and install each package into a new temporary consumer project.
