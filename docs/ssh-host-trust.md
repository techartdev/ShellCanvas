# SSH host identity checks

Before authenticating, ShellCanvas compares the server's public host key with the user's `~/.ssh/known_hosts`. The connection uses one bounded file snapshot for parsing and matching. It never authenticates first and verifies later.

Supported entries follow the [OpenSSH known_hosts format](https://man.openbsd.org/sshd.8#SSH_KNOWN_HOSTS_FILE_FORMAT): plain hostnames/IP addresses, comma-separated aliases, `*`/`?` patterns, negated patterns, hashed names, and bracketed endpoints for nondefault ports (including IPv6). Hostname matching is ASCII case-insensitive. Whitespace-separated fields, leading whitespace and comments are accepted. Host input must be a hostname or unbracketed IP address; host-pattern syntax is not accepted as a connection destination.

- Any matching, explicitly recorded raw public key is sufficient, unless that same key is revoked by a matching `@revoked` line. Revocation wins regardless of line order.
- A host with recorded raw keys but no matching offered key is a mismatch, including when the offered algorithm differs. It cannot be classified as a new host.
- Unrelated revocation and certificate-authority entries no longer disable the entire file. A matching `@cert-authority` entry alone does not authorize a raw key. Hosts requiring certificate verification still fail, and offered host certificates remain unsupported. A separately recorded matching raw key can be used alongside a CA entry.
- A missing file or absence of a matching entry produces the internal `Unknown` classification. The current connection flow still refuses unknown keys; nothing is accepted or saved automatically.
- Unreadable, non-UTF-8, oversized (over 4 MiB), malformed or unsupported entries cause an error, even if another entry would match. This is a deliberate fail-closed restriction; it does not claim every OpenSSH syntax/version is supported. Individual noncomment lines are limited to 64 KiB.

Only the user's known_hosts path is currently consulted. System-wide host files, `HostKeyAlias`, `CanonicalizeHostname`, CA verification, SSHFP/DNS verification and key rotation through `UpdateHostKeys` are not implemented. ShellCanvas does not rewrite the file or remove obsolete entries. Key fingerprints are not sufficient evidence of trust unless checked against an independently trusted source.

## Verification

Tests cover plain/wildcard/negated/hashed entries, aliases, ports, IPv6, whitespace, multiple permitted keys, mismatches, revocation order, unrelated markers, CA-only refusal, malformed entries, invalid endpoints and file bounds. Local generated-key SSH servers additionally check unknown/changed/revoked/malformed cases before authentication, and known/unrelated-marker cases through password authentication. They bind only to loopback, use temporary known_hosts fixtures and an in-memory generated host key, and never alter the user's real trust file or credentials.

The 2026-09-08 run passed 38 Rust tests and all-target Clippy. The additional alias and different-key-algorithm cases passed in the focused host-key suite. The authorized read-only evtinsait regression passed existing known-host verification, key authentication, Linux inspection, SFTP locations/preview, PTY input/resize and disconnect. HMAC/SHA-1 for hashed hostname matching and the test RNG reuse dependency versions already present through russh; no new package versions remain in the lockfile.

## Enrollment follow-up

Fingerprint review and persistence remain pending. Enrollment must use a typed unknown-key result, bind the proposal to one native connection attempt and exact host/port/key, support cancellation/expiry, and recheck the key on the authenticated connection. Changed/revoked/malformed/unsupported-policy errors must never become enrollment prompts. Persisted approval needs concurrency checks and atomic writes; browser state alone must not authorize a different endpoint or key. SSH agent and keyboard-interactive authentication remain separate tasks.
