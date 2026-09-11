# Changelog

ShellCanvas follows semantic versioning for published SDK packages. Desktop releases use the same version where practical. The project is pre-1.0, so minor releases may include breaking changes with migration notes.

## Unreleased

- Fixed: folder transfers (Download, Upload, remote Copy and Paste) no longer stop at 250,000 discovered items or 128 MiB of catalog metadata. Discovery is incremental and disk-backed again, matching the transfer contract documented for the 0.1.0 app SDK.
- Fixed: a full temporary-files disk during folder discovery or transfer is reported as storage exhaustion instead of an SQLite error or a folder conflict, and the scratch catalog is removed.
- Changed (new rejection condition): every transfer catalog entry, whether a selection root, a discovered provider entry or a local file, is refused when its decoded path, name, kind and revision strings together exceed 4 MiB of UTF-8. This counts those four strings, not the serialized catalog row. Built-in SFTP entries are held to a few kilobytes by existing name and path validation, and a conforming adapter cannot fit a larger entry into one 4 MiB protocol frame.
- Changed: Explorer clipboard offers keep the 0.1.0 threshold of 250,000 items, because Windows holds one in-memory descriptor per item, and now refuse larger selections with their own message suggesting Download.
- Added: a full-desktop app launcher for every app that can open now, with search, keyboard navigation and running indicators.
- Changed: **Apps** is now **App Manager**, a store-style manager with tiles, search, per-app details (status, source, approved access, update, disable and confirmed removal) and an **Add apps** page for GitHub and package-file installs.
- Added (app packages and SDK): optional one-line `description` and embedded `icon` fields. `shellcanvas-app build` embeds a PNG, JPEG, WebP or SVG icon of at most 256 KiB, and `shellcanvas-app init --description` and `repository` fill descriptions. Apps without an icon get a generic one. Packages that use the new fields need a desktop newer than 0.1.0; existing packages are unchanged.
- Fixed: installed apps opened in a workspace without an SSH target (connection adapters, the preview) now finish starting. Their environment event carried an undefined `host.target`, which the event journal rejected; the field is now omitted.

## 0.1.0

Initial public preview:

- Tauri desktop with SSH/SFTP workspaces, Files, Terminal, Editor and Host details.
- Saved hosts, host-key review, reconnect and multi-workspace behavior.
- Runtime app packages, themes and provisional public app APIs.
- Rust adapter and filesystem SDKs for independently packaged connections.
- Windows NSIS and MSI installer build path.

See the repository documentation and release notes for current platform validation and known limitations.
