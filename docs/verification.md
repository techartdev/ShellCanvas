# Local verification and release checklist

Install the README's platform prerequisites, then install the committed frontend dependencies with `npm ci`. From the checkout root:

```sh
npm run verify
npm run verify -- --native
```

The default command runs the verification runner's failure-path checks, Rust formatting without edits, the public app SDK build/schema/packer checks, the frontend tests and production build, locked Rust workspace tests, and locked all-target Clippy with warnings treated as failures. `--native` additionally builds the current platform's debug desktop executable with embedded frontend assets. It does not create an installer, sign, publish, push, launch the app or connect to a remote host. Cargo may fetch missing locked dependencies; install prerequisites/dependencies before an offline run.

The separate `npm run verify:sdk` command packs and installs the SDK into fresh projects outside the repository and builds generated app fixtures. It may download build dependencies. See [the standalone SDK workflow and native fixture](app-sdk.md) for scope, retained temporary project locations and UI verification.

Commands run sequentially and stop on the first failure. Missing executables, signals and launch errors fail verification; later checks remain **not-run**. There is no automatic retry, format rewrite, dependency installation or live-host fallback. Fix the reported problem, then run the command again.

Each invocation writes a unique JSON report under ignored `.local/verification/`, with tool versions, platform, command results, duration and source identity. Source fingerprints include HEAD, working-tree changes and untracked non-ignored files. A source change during the run makes the result fail. Avoid editing or committing during verification. A stopped run can leave a report marked running; that is incomplete evidence, never a pass. The report is a local diagnostic record, not a signed provenance attestation or a guarantee that ignored dependencies/build inputs were immutable.

A passing default report covers automated source checks on that machine. A passing native report adds compilation of that machine's debug executable. Neither proves native interactions, live remote writes, network interruption, packaging, performance, other operating systems or overall completion of the backlog.

## Before sharing a candidate build

- Record the intended commit and review the diff, supported-device matrix and known limitations. Use a clean checkout and `npm ci`; run `npm run verify -- --native` and retain its report. Do not transfer a dirty-checkout result to a later clean commit without rerunning.
- Run the relevant browser fixtures for changed UI paths. Check the ordinary desktop, compact windows, keyboard focus/menus, multiple app instances and switching between independent workspaces.
- Use the native application to check connection/trust, file browsing, terminal input/output, clipboard, editor save/dirty-close and reconnect behavior. Match claims to the platform and paths actually exercised. [Windows file workflows](native-file-workflows.md), [window management](window-management.md) and [connection recovery](connection-recovery.md) record existing evidence and gaps.
- Obtain authorization for every real test host. Start with the README's read-only probe; mutations use newly owned disposable fixtures only. Retain exact test paths until cleanup is verified. Copy/transfer probes and the native helper are documented in [transfers](transfers.md) and [native file workflows](native-file-workflows.md). They are never launched by `verify`.
- Exercise permission refusal, cancellation, stale source/destination, disconnect and uncertain publication for the changed remote operations. Browser fakes and provider tests cannot establish physical-network failure behavior. Keep unverified gates explicit in [core completion](core-completion.md) and the backlog.
- Check the final artifact's version, executable identity, asset loading, launch/exit and platform prerequisites. Record the artifact hash, size and platform. Current debug build success does not establish optimized release, installer, signing, updates or mobile support; those remain SHIP-02/03.
- Review what will be shared: exclude `.local`, credentials, host records, private terminal/file contents and debug artifacts not intended for distribution. Public release, hosted CI and commercial packaging remain separate decisions.

The automated command is portable JavaScript and uses direct executable arguments rather than a shell. It is validated on Windows; macOS/Linux execution and native packages still need their own checks.
