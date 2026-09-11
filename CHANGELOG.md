# Changelog

Notable changes to ShellCanvas, newest first. Published SDK packages follow [semantic versioning](https://semver.org/), and desktop releases use the same version where practical. The project is pre-1.0, so a minor release may include breaking changes; those come with migration notes.

## [Unreleased]

### Added

- A full-desktop app launcher for every app that can open now, with search, keyboard navigation and running indicators.
- **App packages and SDK:** optional one-line `description` and embedded `icon` fields. `shellcanvas-app build` embeds a PNG, JPEG, WebP or SVG icon of at most 256 KiB, and `shellcanvas-app init --description` and `repository` fill descriptions. Apps without an icon get a generic one. Packages that use the new fields need a desktop newer than 0.1.0; existing packages are unchanged.

### Changed

- **Apps** is now **App Manager**, a store-style manager with tiles, search, per-app details (status, source, approved access, update, disable and confirmed removal) and an **Add apps** page for GitHub and package-file installs.
- The built-in Canvas theme (1.1.0) uses neutral white and charcoal surfaces with blue accents in both light and dark, replacing the green-tinted palette. Custom themes are unchanged.
- **New rejection condition:** every transfer catalog entry, whether a selection root, a discovered provider entry or a local file, is refused when its decoded path, name, kind and revision strings together exceed 4 MiB of UTF-8. This counts those four strings, not the serialized catalog row. Built-in SFTP entries are held to a few kilobytes by existing name and path validation, and a conforming adapter cannot fit a larger entry into one 4 MiB protocol frame.
- Explorer clipboard offers keep the 0.1.0 threshold of 250,000 items, because Windows holds one in-memory descriptor per item, and now refuse larger selections with their own message suggesting Download.

### Fixed

- Folder transfers (Download, Upload, remote Copy and Paste) no longer stop at 250,000 discovered items or 128 MiB of catalog metadata. Discovery is incremental and disk-backed again, matching the transfer contract documented for the 0.1.0 app SDK.
- A full temporary-files disk during folder discovery or transfer is reported as storage exhaustion instead of an SQLite error or a folder conflict, and the scratch catalog is removed.
- Installed apps opened in a workspace without an SSH target (connection adapters, the preview) now finish starting. Their environment event carried an undefined `host.target`, which the event journal rejected; the field is now omitted.
- Closing ShellCanvas while a local drive is attached no longer hides the window and leaves ShellCanvas and the Drive Bridge running in the background. Quitting is refused with a message until drives are detached, and no drive can start attaching once the window is closing.
- **Windows:** drive letters held by remembered but disconnected network drives are no longer offered or accepted for drive attachment.

## [0.1.1] - 2026-09-11

### Fixed

- Installed apps could not save, read or use API connections ("Invalid app connection identity"). Connections are keyed by the app's installation, whose identifier the desktop's native check wrongly rejected. A key saved by an earlier build under the app ID must be entered once more.

## [0.1.0] - 2026-09-10

The initial public preview.

### Added

- Tauri desktop with SSH/SFTP workspaces, Files, Terminal, Editor and Host details.
- Saved hosts, host-key review, reconnect and multi-workspace behavior.
- Runtime app packages, themes and provisional public app APIs.
- Rust adapter and filesystem SDKs for independently packaged connections.
- Windows NSIS and MSI installer build path.

See the repository documentation and release notes for current platform validation and known limitations.

[Unreleased]: https://github.com/techartdev/ShellCanvas/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/techartdev/ShellCanvas/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/techartdev/ShellCanvas/releases/tag/v0.1.0
