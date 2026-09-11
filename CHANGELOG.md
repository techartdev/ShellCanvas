# Changelog

ShellCanvas follows semantic versioning for published SDK packages. Desktop releases use the same version where practical. The project is pre-1.0, so minor releases may include breaking changes with migration notes.

## Unreleased

- Fixed: folder transfers (Download, Upload, remote Copy and Paste) no longer stop at 250,000 discovered items or 128 MiB of catalog metadata. Discovery is incremental and disk-backed again, matching the transfer contract documented for the 0.1.0 app SDK.
- Fixed: a full temporary-files disk during folder discovery or transfer is reported as storage exhaustion instead of an SQLite error or a folder conflict, and the scratch catalog is removed.
- Changed (new rejection condition): every transfer catalog entry, whether a selection root, a discovered provider entry or a local file, is refused when its decoded path, name, kind and revision strings together exceed 4 MiB of UTF-8. This counts those four strings, not the serialized catalog row. Built-in SFTP entries are held to a few kilobytes by existing name and path validation, and a conforming adapter cannot fit a larger entry into one 4 MiB protocol frame.
- Changed: Explorer clipboard offers keep the 0.1.0 threshold of 250,000 items, because Windows holds one in-memory descriptor per item, and now refuse larger selections with their own message suggesting Download.

## 0.1.0

Initial public preview:

- Tauri desktop with SSH/SFTP workspaces, Files, Terminal, Editor and Host details.
- Saved hosts, host-key review, reconnect and multi-workspace behavior.
- Runtime app packages, themes and provisional public app APIs.
- Rust adapter and filesystem SDKs for independently packaged connections.
- Windows NSIS and MSI installer build path.

See the repository documentation and release notes for current platform validation and known limitations.
