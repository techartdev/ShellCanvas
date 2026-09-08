// SPDX-License-Identifier: MPL-2.0
//! Strict, snapshot-based OpenSSH known_hosts classification, before authentication.
use anyhow::{bail, Context, Result};
use hmac::{Hmac, KeyInit, Mac};
use russh::keys::{
    self,
    ssh_key::known_hosts::{Entry, HostPatterns, Marker},
};
use sha1::Sha1;
use std::{fs::File, io::Read, path::Path};

const MAX_KNOWN_HOSTS: u64 = 4 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub enum HostKeyStatus {
    Trusted,
    Unknown,
}

/// '*' and '?' only, with literal brackets/colons (including [host]:port).
/// Greedy wildcard matching uses constant memory and does not interpret regexes.
fn wildcard(pattern: &str, host: &str) -> bool {
    let p = pattern.as_bytes();
    let h = host.as_bytes();
    let (mut i, mut j, mut star, mut retry) = (0, 0, None, 0);
    while j < h.len() {
        if i < p.len() && (p[i] == b'?' || p[i].eq_ignore_ascii_case(&h[j])) {
            i += 1;
            j += 1;
        } else if i < p.len() && p[i] == b'*' {
            star = Some(i);
            i += 1;
            retry = j;
        } else if let Some(position) = star {
            retry += 1;
            j = retry;
            i = position + 1;
        } else {
            return false;
        }
    }
    while i < p.len() && p[i] == b'*' {
        i += 1;
    }
    i == p.len()
}

fn matches_host(patterns: &HostPatterns, endpoint: &str) -> Result<bool> {
    match patterns {
        HostPatterns::HashedName { salt, hash } => {
            if salt.len() != 20 {
                bail!("Invalid known_hosts hash salt length");
            }
            let mut mac = Hmac::<Sha1>::new_from_slice(salt).context("Invalid hashed host salt")?;
            mac.update(endpoint.as_bytes());
            Ok(mac.verify_slice(hash).is_ok())
        }
        HostPatterns::Patterns(patterns) => {
            let mut matched = false;
            for pattern in patterns {
                let (negative, pattern) = match pattern.strip_prefix('!') {
                    Some(value) => (true, value),
                    None => (false, pattern.as_str()),
                };
                if pattern.is_empty() || pattern.contains(['!', '|']) {
                    bail!("Invalid known_hosts hostname pattern");
                }
                if wildcard(pattern, endpoint) {
                    if negative {
                        return Ok(false);
                    }
                    matched = true;
                }
            }
            Ok(matched)
        }
    }
}

pub fn validate_ssh_endpoint(host: &str, port: u16) -> Result<()> {
    if host.is_empty()
        || host.len() > 1024
        || port == 0
        || host
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "*?!,|[]/\\#@".contains(c))
    {
        bail!("Enter a hostname or unbracketed IP address and a valid port.");
    }
    Ok(())
}

/// Missing files mean no prior trust. Unreadable, oversized or malformed files
/// are errors, never Unknown, so enrollment cannot bypass existing policy.
pub fn assess_host_key(
    host: &str,
    port: u16,
    key: &keys::PublicKey,
    path: &Path,
) -> Result<HostKeyStatus> {
    validate_ssh_endpoint(host, port)?;
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(HostKeyStatus::Unknown)
        }
        Err(error) => return Err(error).context("Cannot read known_hosts; connection refused"),
    };
    let mut bytes = Vec::new();
    file.take(MAX_KNOWN_HOSTS + 1)
        .read_to_end(&mut bytes)
        .context("Cannot read known_hosts")?;
    if bytes.len() as u64 > MAX_KNOWN_HOSTS {
        bail!("known_hosts exceeds the 4 MiB limit; connection refused");
    }
    let contents = std::str::from_utf8(&bytes)
        .context("known_hosts is not valid UTF-8; connection refused")?;
    assess_contents(host, port, key, contents)
}

fn assess_contents(
    host: &str,
    port: u16,
    key: &keys::PublicKey,
    contents: &str,
) -> Result<HostKeyStatus> {
    let host = host.to_ascii_lowercase();
    let endpoint = if port == 22 {
        host
    } else {
        format!("[{host}]:{port}")
    };
    let (mut trusted, mut recorded, mut ca_only) = (false, false, false);
    for (number, line) in contents.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.len() > 64 * 1024 {
            bail!("known_hosts line {} is too long", number + 1);
        }
        // The library parser expects single spaces; OpenSSH also accepts tabs.
        let words: Vec<_> = line.split_whitespace().collect();
        let fields = if words[0].starts_with('@') { 4 } else { 3 };
        if words.len() < fields {
            bail!("Malformed known_hosts entry on line {}", number + 1);
        }
        let patterns = words[fields - 3];
        if patterns.starts_with('|') {
            // The parser decodes into a fixed-size buffer; explicitly reject a
            // short/trailing hash instead of treating it as a nonmatching host.
            let parts: Vec<_> = patterns.split('|').collect();
            if parts.len() != 4 || parts[1] != "1" || parts[3].len() != 28 {
                bail!("Invalid known_hosts hash on line {}", number + 1);
            }
        } else if patterns.split(',').any(|p| {
            let p = p.strip_prefix('!').unwrap_or(p);
            p.is_empty() || p.contains(['!', '|'])
        }) {
            bail!("Invalid known_hosts pattern on line {}", number + 1);
        }
        let entry: Entry = words[..fields].join(" ").parse().with_context(|| {
            format!(
                "Malformed or unsupported known_hosts entry on line {}",
                number + 1
            )
        })?;
        if !matches_host(entry.host_patterns(), &endpoint)? {
            continue;
        }
        match entry.marker() {
            Some(Marker::Revoked) => {
                if entry.public_key().key_data() == key.key_data() {
                    bail!(
                        "REVOKED HOST KEY: connection refused (known_hosts line {})",
                        number + 1
                    );
                }
            }
            Some(Marker::CertAuthority) => ca_only = true,
            None => {
                recorded = true;
                if entry.public_key().key_data() == key.key_data() {
                    trusted = true;
                }
            }
        }
    }
    if trusted {
        return Ok(HostKeyStatus::Trusted);
    }
    if recorded {
        bail!(
            "HOST KEY MISMATCH: the server identity differs from known_hosts. Connection refused."
        );
    }
    if ca_only {
        bail!("This host requires certificate verification, which is not supported yet. Connection refused.");
    }
    Ok(HostKeyStatus::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;
    const KEY: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const OTHER: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB";
    fn assess(host: &str, port: u16, text: &str) -> Result<HostKeyStatus> {
        assess_contents(
            host,
            port,
            &keys::parse_public_key_base64(KEY).unwrap(),
            text,
        )
    }
    #[test]
    fn matches_patterns_negations_ports_ipv6_and_whitespace() {
        assert_eq!(
            assess("alias", 22, &format!("server,alias ssh-ed25519 {KEY}")).unwrap(),
            HostKeyStatus::Trusted
        );
        let text = format!("  # comment\n  *.example,!excluded.example\tssh-ed25519\t{KEY}\tcomment\n[server]:2222 ssh-ed25519 {KEY}\n[::1]:2200 ssh-ed25519 {KEY}\n");
        assert_eq!(
            assess("NODE.EXAMPLE", 22, &text).unwrap(),
            HostKeyStatus::Trusted
        );
        assert_eq!(
            assess("excluded.example", 22, &text).unwrap(),
            HostKeyStatus::Unknown
        );
        assert_eq!(
            assess("server", 2222, &text).unwrap(),
            HostKeyStatus::Trusted
        );
        assert_eq!(assess("server", 22, &text).unwrap(), HostKeyStatus::Unknown);
        assert_eq!(assess("::1", 2200, &text).unwrap(), HostKeyStatus::Trusted);
        for (pattern, host, expected) in [
            ("a?c", "abc", true),
            ("a*bc", "abbbc", true),
            ("*ab*bc", "abc", false),
            ("*", "", true),
            ("a?", "a", false),
        ] {
            assert_eq!(wildcard(pattern, host), expected);
        }
    }
    #[test]
    fn revocation_wins_and_unrelated_markers_do_not_break_known_hosts() {
        let plain = format!("server ssh-ed25519 {KEY}\n");
        for text in [
            format!("{plain}@revoked server ssh-ed25519 {KEY}\n"),
            format!("@revoked * ssh-ed25519 {KEY}\n{plain}"),
        ] {
            assert!(assess("server", 22, &text)
                .unwrap_err()
                .to_string()
                .contains("REVOKED"));
        }
        let unrelated = format!(
            "@revoked other ssh-ed25519 {KEY}\n@cert-authority *.corp ssh-ed25519 {OTHER}\n{plain}"
        );
        assert_eq!(
            assess("server", 22, &unrelated).unwrap(),
            HostKeyStatus::Trusted
        );
        assert!(assess("host.corp", 22, &unrelated)
            .unwrap_err()
            .to_string()
            .contains("certificate"));
        // A separately pinned raw key is still valid even when a CA is also listed.
        assert_eq!(
            assess(
                "server",
                22,
                &format!("@cert-authority server ssh-ed25519 {OTHER}\n{plain}")
            )
            .unwrap(),
            HostKeyStatus::Trusted
        );
    }
    #[test]
    fn accepts_any_explicit_valid_key_but_never_a_changed_or_malformed_entry() {
        let different_algorithm = keys::PrivateKey::random(
            &mut rand::rng(),
            keys::Algorithm::Ecdsa {
                curve: keys::EcdsaCurve::NistP256,
            },
        )
        .unwrap();
        assert!(assess(
            "server",
            22,
            &format!(
                "server {}",
                different_algorithm.public_key().to_openssh().unwrap()
            )
        )
        .unwrap_err()
        .to_string()
        .contains("MISMATCH"));
        assert_eq!(
            assess(
                "server",
                22,
                &format!("server ssh-ed25519 {OTHER}\nserver ssh-ed25519 {KEY}")
            )
            .unwrap(),
            HostKeyStatus::Trusted
        );
        assert!(assess("server", 22, &format!("server ssh-ed25519 {OTHER}"))
            .unwrap_err()
            .to_string()
            .contains("MISMATCH"));
        for line in [
            "server",
            "server ssh-ed25519 broken",
            "@unsupported server ssh-ed25519",
            "server ssh-rsa",
        ] {
            assert!(assess("server", 22, line).is_err());
        }
        for host_pattern in [
            "server,",
            "!",
            "server,,other",
            "|1|AA==|AA==",
            "|2|AA==|AA==",
        ] {
            assert!(assess("new", 22, &format!("{host_pattern} ssh-ed25519 {KEY}")).is_err());
        }
        assert!(assess("new", 22, &format!("server ssh-ed25519 {KEY}\nmalformed")).is_err());
    }
    #[test]
    fn supports_hashed_entries_without_ignoring_negated_patterns() {
        // OpenSSH-compatible known_hosts fixture, shared with russh's parser tests.
        let encoded = "AAAAC3NzaC1lZDI1NTE5AAAAILIG2T/B0l0gaqj3puu510tu9N1OkQ4znY3LYuEm5zCF";
        let key = keys::parse_public_key_base64(encoded).unwrap();
        let text = format!(
            "|1|O33ESRMWPVkMYIwJ1Uw+n877jTo=|nuuC5vEqXlEZ/8BXQR7m619W6Ak= ssh-ed25519 {encoded}"
        );
        assert_eq!(
            assess_contents("example.com", 22, &key, &text).unwrap(),
            HostKeyStatus::Trusted
        );
        assert_eq!(
            assess_contents("example.com", 2222, &key, &text).unwrap(),
            HostKeyStatus::Unknown
        );
        assert_eq!(
            assess("server", 22, &format!("*,!server ssh-ed25519 {KEY}")).unwrap(),
            HostKeyStatus::Unknown
        );
    }
    #[test]
    fn distinguishes_missing_files_from_invalid_files_and_endpoints() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("known_hosts");
        let key = keys::parse_public_key_base64(KEY).unwrap();
        assert_eq!(
            assess_host_key("server", 22, &key, &path).unwrap(),
            HostKeyStatus::Unknown
        );
        assert!(assess_host_key("server", 22, &key, dir.path()).is_err());
        std::fs::write(&path, [255]).unwrap();
        assert!(assess_host_key("server", 22, &key, &path).is_err());
        std::fs::write(&path, vec![b'#'; MAX_KNOWN_HOSTS as usize + 1]).unwrap();
        assert!(assess_host_key("server", 22, &key, &path).is_err());
        for host in [
            "",
            "server name",
            "server\nother",
            "*.example",
            "a,b",
            "[::1]",
            "!server",
        ] {
            assert!(validate_ssh_endpoint(host, 22).is_err());
        }
    }
}
