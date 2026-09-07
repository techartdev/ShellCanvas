# Remote provider contract and compatibility

Client platforms (where the desktop runs) and remote platforms (what SSH reaches) are separate matrices. Running the client on Windows does not prove Windows SSH-host support.

Connection methods are a third axis: a device provider can consume services from several adapters. Do not tie a provider to one SSH handle or assume files and console share an endpoint/path namespace. See [connection and service composition](connections.md). Additional protocols remain planned.

## Current boundary

`crates/ssh-core/src/provider.rs` has separate `SystemProvider` and `FileSystemProvider` traits. System inspection supplies display information; SFTP supplies file services independently. Unknown systems retain a generic SSH workspace. Terminal capability currently means a shell can be attempted; PTY/shell acceptance is checked on open.

System providers now take `ProbeContext` with optional `CommandProbe` access. Provider selection accepts an ordered list and a total time budget; the SSH entry point supplies LinuxProvider. A context with no independent exec service is valid. These are trusted Rust modules compiled into the application, not dynamically loaded native plugins. Cached probe results and additional structured service facets remain future work.

## Required next contract

1. Probe a device through bounded, fixed, read-only operations. Prefer cached shared results, an explicit unknown outcome and a total detection deadline. An unsupported exec channel must not prevent the generic workspace from opening.
2. Select the most specific supported provider deterministically; allow a future user-selected override. Avoid trying every OS command indefinitely on an appliance.
3. Report services from observed behavior. OS labels never imply SFTP, sudo, systemd, bash or arbitrary exec support. Track unsupported, available and not-yet-probed distinctions where necessary.
4. Keep paths opaque to desktop apps. A filesystem supplies roots, canonical paths and parent navigation. POSIX path concatenation in today's SFTP/Files implementation must be reviewed for Windows and virtual appliances.
5. Describe provider operations with typed inputs/outputs. Desktop apps and AI call services rather than assemble shell commands. Native code owns quoting, limits, session validation and authorization.
6. Offer fixture tests plus opt-in authorized live checks. Adding a provider should not require editing the desktop shell.
7. Never simulate independent command probes by writing into a shared interactive console. Serial/Telnet sessions may require exclusive ownership and device-specific command interpretation. An API provider may not use commands at all.

## Remote support matrix

| Target                        | Current evidence                                                                                            | Next proof                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Ubuntu Linux test host        | Known-host/key auth, system detection, SFTP list/preview, PTY/resize; native Files/Terminal tested by owner | Regression harness, limited account, disabled subsystem and failures      |
| Other Linux / Raspberry Pi OS | Expected reuse of Linux and SFTP paths; not tested                                                          | Real distribution/hardware reports; missing utilities and architectures   |
| macOS SSH                     | No macOS-specific provider or live test                                                                     | Darwin/BSD fixtures, authorized host, paths and PTY                       |
| Windows OpenSSH               | No Windows-specific provider or live test                                                                   | Default shell detection, drive paths, SFTP and PowerShell/cmd             |
| RouterOS / other appliance    | Generic SSH fallback only; device support not validated                                                     | Selected version and authorized device; shell/exec/file capability report |

Existing SFTP support might work on a new system, but do not label that system supported before validating path and lifecycle behavior. A device with no filesystem service should offer Terminal and Host details while Files explains the missing capability.

## Compatibility report

Record provider/version, remote OS/firmware and SSH server, authentication method (no secrets), account privilege level, shell/exec/PTY results, SFTP and path behavior, client OS/build and failure messages with sensitive data removed. Separate fixture results from a live test. Never commit raw host addresses, keys, remote files or terminal transcripts.
