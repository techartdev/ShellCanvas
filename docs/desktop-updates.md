# ShellCanvas desktop updates

The download-arrow button beside the top-bar connection indicator and clock checks for ShellCanvas updates. A blue dot indicates a newer signed package for the current operating system, CPU architecture and installation type. ShellCanvas checks after startup and every six hours; clicking the button also checks manually. Offline checks are quiet until the update dialog is opened.

Choose **Update and close** to download, verify and install. This is always an explicit action, never a silent shutdown. The dialog explains that remote sessions disconnect and that saved hosts, settings, installed apps and app data remain on the machine. The download can be canceled. A download, signature or installer-launch failure leaves the current app open and reports the problem.

Save or close unsaved documents across all workspaces first. Finish app tasks and transfers, and detach local drives. Checks run again after downloading. Native guards serialize installation against active file mutations, transfer preparation/execution, custom service calls, HTTP requests and Windows clipboard streams. New guarded operations are refused once installation begins; an unsuccessful installer launch releases the guard. Terminal sessions themselves do not block updates; closing the application disconnects them as the confirmation explains. Remote background processes may continue according to their host's shell behavior.

## Platform packages

ShellCanvas uses [Tauri's signed updater](https://v2.tauri.app/plugin/updater/). Package-specific manifest keys avoid changing installer families:

| Installation                             | Update target example                      | Installation behavior                                                                  |
| ---------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| Windows NSIS                             | `windows-x86_64-nsis`                      | Passive installer launched in update mode, then the app exits                          |
| Windows MSI                              | `windows-x86_64-msi`                       | MSI upgrade, then the app exits                                                        |
| macOS app bundle (Intel / Apple silicon) | `darwin-x86_64-app` / `darwin-aarch64-app` | Replace the app bundle, then restart                                                   |
| Linux AppImage                           | `linux-x86_64-appimage`                    | Replace the AppImage, then restart                                                     |
| Linux Debian / RPM package               | `linux-x86_64-deb` / `linux-x86_64-rpm`    | Invoke the appropriate package installer, then restart; OS authorization may be needed |

Unpackaged Linux/macOS executables do not offer self-installation. A platform without a published signed package reports that availability gap. Android/iOS distribution updates are outside this desktop updater; their eventual store/update path remains separate.

The updater does not change the application identifier `dev.shellcanvas.client`, storage namespaces or credentials. Application state resides outside the installed binary/bundle. NSIS `/UPDATE` explicitly bypasses app-data deletion in the upstream installer. No uninstall, reset-profile or app-data cleanup action is used by ShellCanvas's updater.

## Release and signing

`bundle.createUpdaterArtifacts` emits signatures. The public verification key is in `src-tauri/tauri.conf.json`. The matching private signing key belongs in the repository's `TAURI_SIGNING_PRIVATE_KEY` Actions secret (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if password-protected), never in source control. Keep an independent protected backup: replacing or losing that key breaks the update chain for existing installations. This updater signature is separate from Windows Authenticode and Apple signing/notarization.

The normal Windows tag workflow uploads EXE, MSI, signatures, checksums and `latest.json`. `scripts/updater-manifest.mjs` builds the manifest from signed artifacts and refuses duplicate targets, missing payloads and mixed versions. The application only accepts downloads from this project's official GitHub releases and verifies the payload signature before offering it to the installer.

The **Add macOS or Linux release packages** workflow is manual while those platforms are undergoing testing. Select an existing tag and one platform; it builds native packages, uploads them, then adds that platform's entries to the same version's manifest. Release workflows are serialized per tag, preserving previously published targets. Existing versioned package assets are never silently replaced. Do not run the workflow against a tag predating updater support.

Local source builds can build without signing artifacts by supplying an additional Tauri config containing `{"bundle":{"createUpdaterArtifacts":false}}`. Published updater packages must use signing; do not disable verification or substitute unsigned downloads.

## Validation status and bootstrap

Controller tests cover explicit consent, duplicate clicks, cancellation/late callbacks, failures, busy/dirty work and rechecking after download. Native tests cover platform/package selection, official release URLs and installation exclusion. Manifest tests cover all supported package families and adding a platform without losing others.

The first release containing this updater must be installed manually: 0.1.4 and earlier cannot update themselves. An actual installed-version-to-new-version upgrade, including retained hosts, settings, app data and credentials, must be tested on Windows NSIS and MSI and on each macOS/Linux distribution before claiming end-to-end validation for that target. macOS/Linux packaging and live upgrades are not yet validated. No installer is launched against a user's running work as part of automated tests.
