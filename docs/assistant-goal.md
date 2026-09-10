# Canvas Assistant integration

Canvas Assistant is an independently built ShellCanvas app. It exercises the
public app SDK, repository installer, permission broker, model connection
service, local history, attachments, and reviewed remote-host tools without
importing desktop internals.

## Architecture

- The assistant UI, conversation history, and tool loop live in the separate
  [ShellCanvas-Assistant](https://github.com/techartdev/ShellCanvas-Assistant)
  project.
- Users configure an OpenAI-compatible endpoint, credential, and model through
  the desktop connection dialog. The native connection service keeps credentials
  outside package fields and conversation storage.
- The app supports OpenAI Responses and compatible Chat Completions transports.
- A repository descriptor identifies a prebuilt package and its SHA-256 digest.
  Installation downloads and reviews those bytes directly; it does not clone the
  repository, install dependencies, or execute build scripts.
- File and console tools depend on explicit grants and the active workspace
  binding. Mutations require a concrete review before dispatch.
- Missing file, console, or device services disable the affected tools while the
  rest of the assistant remains available.

## Verified scope

The Windows integration proof covered:

- repository installation and reviewed updates across package versions;
- retained running windows and grant snapshots during an update;
- streaming responses, cancellation, retry, iteration limits, and partial tool
  failures;
- local conversation history, drafts, text and image attachments, clipboard
  previews, and deliberate context submission;
- workspace discovery, remote file selection, bounded reads, reviewed writes,
  and reviewed console input;
- denied permissions, unavailable services, reconnect and binding changes, stale
  revisions, and separation between credentials and conversation history;
- compact and normal window layouts plus dirty and busy close guards.

The source package has its own tests and build. ShellCanvas also tests the SDK
schema and packer, consumes a packed SDK from a fresh project, and runs native
HTTP tests with generated fixture credentials.

## Security boundaries

Installed assistant code runs through the same isolated frame and capability
broker as every ShellCanvas app. It does not receive unrestricted native IPC,
local filesystem access, or a generic command executor. Repository hashes bind a
review to exact bytes, but they do not authenticate a publisher; users still
review the repository identity, version, digest, and grants.

Model credentials stay in process memory or the platform credential store. The
app receives only public connection metadata and can send requests only to the
exact configured endpoint through the bounded network broker.

## Current limits

The installed-app proof currently targets Windows. Native app isolation on macOS
and Linux, provider OAuth, automatic context compaction, unattended background
work, and multi-host agent runs require separate validation before support is
claimed.
