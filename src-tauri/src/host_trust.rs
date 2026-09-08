// SPDX-License-Identifier: MPL-2.0
use anyhow::{bail, Context, Result};
use shellcanvas_core::{verify_host_key_with_store, UnknownHostKey};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_SIZE: u64 = 4 * 1024 * 1024;
pub fn store_path(dir: &Path) -> PathBuf {
    dir.join("known_hosts")
}

/// Only called with the native-held candidate after approval of its one-use token.
/// No replacement/removal API: existing conflicting identities must be resolved separately.
pub fn remember(dir: &Path, user_known_hosts: &Path, candidate: &UnknownHostKey) -> Result<()> {
    fs::create_dir_all(dir).context("Cannot create host trust directory")?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("known_hosts.lock"))?;
    lock.lock().context("Cannot lock the host trust store")?;
    let path = store_path(dir);
    match verify_host_key_with_store(
        &candidate.host,
        candidate.port,
        &candidate.key,
        user_known_hosts,
        Some(&path),
    ) {
        Ok(()) => return Ok(()), // Another authorized writer already recorded it.
        Err(error) if error.downcast_ref::<UnknownHostKey>().is_some() => {}
        Err(error) => {
            return Err(error).context("Host trust changed during review; nothing was saved")
        }
    }
    let mut bytes = Vec::new();
    match File::open(&path) {
        Ok(file) => {
            file.take(MAX_SIZE + 1).read_to_end(&mut bytes)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("Cannot read host trust store"),
    }
    if !bytes.is_empty() && !bytes.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    let host = candidate.host.to_ascii_lowercase();
    let endpoint = if candidate.port == 22 {
        host
    } else {
        format!("[{host}]:{}", candidate.port)
    };
    bytes.extend_from_slice(format!("{endpoint} {}\n", candidate.key.to_openssh()?).as_bytes());
    if bytes.len() as u64 > MAX_SIZE {
        bail!("Host trust store exceeds 4 MiB; nothing was saved");
    }
    let mut temporary = tempfile::NamedTempFile::new_in(dir)?;
    temporary.write_all(&bytes)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist(&path)
        .context("Cannot save the host trust store")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use shellcanvas_core::UnknownHostKey;
    fn candidate(host: &str, port: u16) -> UnknownHostKey {
        // Public fixture keys contain no credentials.
        UnknownHostKey {
            host: host.into(),
            port,
            key: russh_key("AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
        }
    }
    fn russh_key(encoded: &str) -> shellcanvas_core::HostPublicKey {
        shellcanvas_core::HostPublicKey::from_openssh(&format!("ssh-ed25519 {encoded}")).unwrap()
    }
    #[test]
    fn persists_exact_endpoint_and_key_without_editing_user_trust() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("user_known_hosts");
        fs::write(&user, "# user managed\n").unwrap();
        let app = dir.path().join("app");
        let key = candidate("Server", 2222);
        remember(&app, &user, &key).unwrap();
        remember(&app, &user, &key).unwrap();
        let bytes = fs::read(store_path(&app)).unwrap();
        assert_eq!(String::from_utf8(bytes.clone()).unwrap().lines().count(), 1);
        assert_eq!(fs::read(&user).unwrap(), b"# user managed\n");
        assert!(verify_host_key_with_store(
            "server",
            2222,
            &key.key,
            &user,
            Some(&store_path(&app))
        )
        .is_ok());
        assert!(
            verify_host_key_with_store("server", 22, &key.key, &user, Some(&store_path(&app)))
                .unwrap_err()
                .downcast_ref::<UnknownHostKey>()
                .is_some()
        );
        let mut changed = candidate("server", 2222);
        changed.key =
            russh_key("AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB");
        assert!(remember(&app, &user, &changed).is_err());
        assert_eq!(fs::read(store_path(&app)).unwrap(), bytes);
        fs::write(
            &user,
            format!("@revoked [server]:2222 {}\n", key.key.to_openssh().unwrap()),
        )
        .unwrap();
        assert!(remember(&app, &user, &key).is_err());
        assert_eq!(fs::read(store_path(&app)).unwrap(), bytes);
    }
    #[test]
    fn concurrent_approvals_preserve_both_records_and_corruption_is_not_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let user = dir.path().join("missing");
        let app = dir.path().join("app");
        std::thread::scope(|scope| {
            for host in ["one", "two"] {
                let (app, user) = (&app, &user);
                scope.spawn(move || remember(app, user, &candidate(host, 22)).unwrap());
            }
        });
        assert_eq!(
            fs::read_to_string(store_path(&app))
                .unwrap()
                .lines()
                .count(),
            2
        );
        fs::write(store_path(&app), "malformed trust record").unwrap();
        assert!(remember(&app, &user, &candidate("three", 22)).is_err());
        assert_eq!(
            fs::read_to_string(store_path(&app)).unwrap(),
            "malformed trust record"
        );
    }
}
