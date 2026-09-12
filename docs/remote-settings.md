# Provider-defined remote settings

Open **Host details → Remote settings**. Desktop Settings → Hosts also opens the current host's details. This is separate from saved connection profiles and local appearance preferences.

Providers supply field IDs, labels, descriptions, text/select editors, current values, choices, revisions and per-field read-only reasons. The UI contains no Linux commands or setting IDs. Unknown providers keep an explanatory settings page and their other usable apps; missing tools disable only the affected field. `HostSettingsService` lives in the connection-independent `crates/service-contracts`. Trusted system providers optionally supply an implementation when selected by detection.

## Current Linux fields

- **Static hostname:** read and set through `hostnamectl --static`. Accepted values are lowercase DNS labels separated by dots, up to 64 characters. Whitespace, shell syntax, options and empty labels are refused. Pretty/transient names, DNS records, `/etc/hosts`, saved connection addresses and SSH trust entries are not edited. Connection titles and Overview retain their connection-time snapshot until reconnect.
- **Timezone:** current value and supported choices come from `timedatectl`. Selection must match a freshly read host choice. Changing it affects remote local timestamps and scheduled jobs; the desktop clock picks up the new offset at its next refresh (normally within a minute). Clock time, NTP policy and hardware-clock mode are not changed.

Writes are currently offered only when the remote account reports UID 0. Other accounts can read supported values. The provider does not invoke sudo or request an interactive privilege prompt. Even root can be refused by service/container policy; failures are reported. Linux detection alone does not promise working controls: systemd utilities and their host services are required. No packages or remote agent are installed.

The behavior follows upstream [hostnamectl documentation](https://www.freedesktop.org/software/systemd/man/latest/hostnamectl.html) and [timedatectl documentation](https://www.freedesktop.org/software/systemd/man/latest/timedatectl.html). The adapter uses the older `set-hostname` verb for compatibility and `--no-ask-password` to avoid interactive authentication. Commands stay inside the provider behind a bounded interface; this form has no generic command IPC endpoint.

## Review, conflict and failure behavior

Editing produces an in-memory proposal. **Review change** shows the host, current and proposed values. **Apply to host** submits just that field. Keeping editing or resetting a draft issues no remote write. Window/workspace/app closure guards unsaved proposals; closing is disabled during apply. Minimizing and switching to Overview retain proposals.

Before dispatch, the provider validates the field/value, checks account access, rereads the setting and compares its revision. Writes within one provider instance are serialized. Success requires a successful command and matching readback. Failure after dispatch reports possible uncertainty. The UI retains the proposal and requires **Refresh settings** before another review. Refresh updates the remote baseline while retaining proposed values.

Revisions reflect the field's current value, not an atomic system-wide transaction. Other processes can change a setting after the precheck; change-away/change-back cannot be detected. There is no distributed lock, rollback or automatic retry. A timeout or connection loss can leave a change applied without confirmation. Inspect refreshed state before retrying. Commands bound output and time out after 15 seconds each; inspection can involve several commands.

Proposals are not persisted across restart or forced termination. Network, service, account and security administration are outside this first schema. Other providers may supply different fields; external provider loading and permissions remain separate design work.

## Evidence

- Rust tests cover absent tools, read-only accounts, unsupported providers/fields, invalid shell-like values before any command, unsupported timezone choices, stale revisions, concurrent changes, no-op writes, one-field application, failed commands and failed readback.
- Session tests cover capability enforcement, owning-host routing, stale reads and uncertain mutation completion after disposal.
- `/tests/fixtures/remote-settings.html` passed hostname/timezone review/application, canceled review, unsaved/busy close protection, concurrent-change refusal with proposal retention, refreshed baseline, read-only fields and missing timezone tools. Desktop and 768px tablet layouts were inspected, including lower-field scrolling.
- The read-only core probe on the authorized Linux host read both fields twice with stable revisions, discovered 497 timezone choices and disconnected. It never called `apply` and changed no remote settings. Actual mutations and unprivileged OS authorization still need a disposable systemd host test; command fixtures do not prove those integrations.

```sh
cargo run -p shellcanvas-core --example settings_probe -- HOST USER KEY_PATH
```
