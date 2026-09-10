# Security policy

ShellCanvas handles remote credentials, host identity, files, terminals and third-party extension packages. Please report suspected vulnerabilities privately instead of opening a public issue.

Use GitHub's **Report a vulnerability** form in the repository Security tab. Include the affected version, platform, prerequisites, impact and a minimal reproduction. Remove passwords, private keys, tokens, private host names and user file contents from reports.

The maintainers will acknowledge a report, investigate it and coordinate a fix and disclosure when the issue is confirmed. There is no paid bug-bounty program unless a separate program says otherwise.

## Supported versions

ShellCanvas is an early prototype. Security fixes are applied to the latest release and the current default branch. Older builds are not supported.

## Important boundaries

- The terminal has the permissions of the authenticated remote account.
- Host keys are checked before authentication; changed and revoked keys remain blocked.
- Installed native adapters execute with the local user's operating-system permissions and require explicit trust.
- Installed runtime-app isolation currently has targeted Windows/WebView2 validation. Other platforms and hostile-code containment are not claimed.
- Browser fixtures and development previews use synthetic data and do not establish native production security.

These boundaries describe the current design; they do not replace coordinated vulnerability reporting.
