// SPDX-License-Identifier: MPL-2.0
use serde::Serialize;
use std::path::PathBuf;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProfile {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub key_path: String,
}

pub fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return dirs::home_dir().unwrap_or_default();
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

// Deliberately imports only explicit Host blocks. Never executes ProxyCommand or
// expands Include/Match. This is a profile importer, not an OpenSSH config engine.
pub fn parse_profiles(config: &str) -> Vec<HostProfile> {
    let mut profiles = Vec::new();
    let mut current: Vec<HostProfile> = Vec::new();
    for line in config.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(split) = line.find(|c: char| c.is_whitespace() || c == '=') else {
            continue;
        };
        let key = line[..split].to_ascii_lowercase();
        let value = line[split..]
            .trim_start_matches(|c: char| c.is_whitespace() || c == '=')
            .trim();
        if key == "host" || key == "match" {
            profiles.append(&mut current);
            if key == "host" {
                current = value
                    .split_whitespace()
                    .filter(|s| !s.contains(['*', '?', '!']))
                    .map(|host| HostProfile {
                        name: host.to_owned(),
                        host: host.to_owned(),
                        port: 22,
                        ..Default::default()
                    })
                    .collect();
            }
            continue;
        }
        let value = value.trim_matches('"');
        for profile in &mut current {
            match key.as_str() {
                "hostname" => profile.host = value.to_owned(),
                "user" => profile.username = value.to_owned(),
                "port" => profile.port = value.parse().unwrap_or(22),
                "identityfile" if profile.key_path.is_empty() => {
                    profile.key_path = expand_home(value).to_string_lossy().into_owned()
                }
                _ => {}
            }
        }
    }
    profiles.append(&mut current);
    profiles
}

pub fn local_profiles() -> Vec<HostProfile> {
    dirs::home_dir()
        .and_then(|p| std::fs::read_to_string(p.join(".ssh/config")).ok())
        .map(|text| parse_profiles(&text))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn imports_only_explicit_hosts_without_executing_directives() {
        let p = parse_profiles("Host *\n User inherited\nHost pi lab\n HostName 192.0.2.1\n User alice\n Port 2222\n IdentityFile \"C:/a b/key\"\n ProxyCommand bad\nMatch all\n User wrong\n");
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].username, "alice");
        assert_eq!(p[1].host, "192.0.2.1");
        assert_eq!(p[1].port, 2222);
        assert_eq!(p[0].key_path, "C:/a b/key");
    }
}
