# Security policy

ShellCanvas handles remote credentials, host identity, files, terminals and third-party packages, so security reports matter to us. Please report suspected vulnerabilities **privately**, never in a public issue or pull request.

## Report a vulnerability

1. Open the repository's **Security** tab and choose **Report a vulnerability**.
2. Describe the affected version and platform, the prerequisites, the impact, and a minimal way to reproduce it.
3. Remove passwords, private keys, tokens, private host names and the contents of your files from the report.

If the private form is not available, open a short public issue that only asks for a private contact. Do not include any details there.

The maintainers acknowledge a report, investigate it, and coordinate a fix and its disclosure with you once the issue is confirmed. There is no paid bug bounty unless a separate program says otherwise.

## Supported versions

ShellCanvas is a public preview. Security fixes go into the latest release and the default branch. Older builds are not supported, so please update before reporting.

## Security model at a glance

These boundaries describe the current design. They help you judge what counts as a vulnerability; they do not replace a report.

- **Host keys come first.** A server's key is checked against your OpenSSH `known_hosts` and ShellCanvas's own trust store before authentication. New keys need your explicit review; changed and revoked keys stay blocked.
- **Secrets stay yours.** Passwords and key passphrases are never saved. Private key files stay where they are. Saved hosts store only non-secret connection details.
- **The terminal is a real shell** with every permission of the account you signed in with, including root if you chose it.
- **Installed apps are isolated on Windows.** Runtime apps run in an isolated frame behind a permission-checking broker. This has targeted Windows and WebView2 validation. Isolation on other platforms and containment of hostile code are not claimed.
- **Connection adapters are native code.** Installed adapters run with your operating-system permissions and require explicit trust. A package hash identifies content; it does not authenticate the publisher.
- **The browser preview is not the product.** Fixtures and development previews use synthetic data and say nothing about native production security.
