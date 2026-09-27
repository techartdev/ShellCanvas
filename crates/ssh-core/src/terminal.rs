// SPDX-License-Identifier: MPL-2.0
use crate::{
    Connection, TerminalReader, TerminalService, TerminalSize, TerminalStream, TerminalWriter,
};
use anyhow::Result;
use async_trait::async_trait;
use russh::{client, ChannelMsg, ChannelReadHalf, ChannelWriteHalf};
use std::{sync::Arc, time::Duration};

/// Retains the detected platform of this SSH source, even in mixed workspaces.
pub struct SshTerminal {
    pub connection: Arc<Connection>,
    pub provider: String,
}

fn directory_command(provider: &str, path: &str) -> Result<String> {
    anyhow::ensure!(
        !path.is_empty() && path.len() <= 32768 && !path.chars().any(char::is_control),
        "Invalid terminal directory"
    );
    match provider {
        "linux" | "macos" => {
            anyhow::ensure!(path.starts_with('/'), "Terminal directory must be absolute");
            let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
            let script = format!("cd {} && exec \"${{SHELL:-/bin/sh}}\" -i", quote(path));
            Ok(format!("sh -c {}", quote(&script)))
        }
        "windows" => {
            use base64::{engine::general_purpose::STANDARD, Engine};
            // OpenSSH SFTP represents drive paths as /C:/directory.
            let path = if path.starts_with('/') && path.as_bytes().get(2) == Some(&b':') {
                &path[1..]
            } else {
                path
            };
            anyhow::ensure!(
                (path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                    && path.as_bytes().get(1) == Some(&b':')
                    && matches!(path.as_bytes().get(2), Some(b'/' | b'\\')))
                    || path.starts_with("\\\\"),
                "Terminal directory must be an absolute Windows path"
            );
            let script = format!(
                "try {{ Set-Location -LiteralPath '{}' -ErrorAction Stop }} catch {{ Write-Error $_; exit 1 }}",
                path.replace('\'', "''")
            );
            let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
            Ok(format!(
                "powershell.exe -NoLogo -NoProfile -NoExit -EncodedCommand {}",
                STANDARD.encode(bytes)
            ))
        }
        _ => anyhow::bail!("This host does not support opening a shell in a directory"),
    }
}

#[async_trait]
impl TerminalService for SshTerminal {
    async fn open(&self, size: TerminalSize) -> Result<TerminalStream> {
        self.connection.open(size).await
    }

    async fn open_directory(&self, size: TerminalSize, path: &str) -> Result<TerminalStream> {
        let command = directory_command(&self.provider, path)?;
        let (reader, writer) = self
            .connection
            .terminal_command(size.cols, size.rows, Some(&command))
            .await?
            .split();
        Ok(TerminalStream {
            reader: Box::new(SshReader(reader)),
            writer: Box::new(SshWriter(Some(writer))),
            resizable: true,
        })
    }
}

struct SshReader(ChannelReadHalf);
struct SshWriter(Option<ChannelWriteHalf<client::Msg>>);

#[async_trait]
impl TerminalReader for SshReader {
    async fn read(&mut self) -> Result<Option<Vec<u8>>> {
        while let Some(message) = self.0.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. }
                    if !data.is_empty() =>
                {
                    return Ok(Some(data.to_vec()))
                }
                ChannelMsg::Close => return Ok(None),
                _ => {}
            }
        }
        Ok(None)
    }
}
#[async_trait]
impl TerminalWriter for SshWriter {
    async fn write(&mut self, bytes: &[u8]) -> Result<()> {
        self.0
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Console is closed"))?
            .data(bytes)
            .await?;
        Ok(())
    }
    async fn resize(&mut self, size: TerminalSize) -> Result<()> {
        let size = TerminalSize::new(size.cols, size.rows);
        self.0
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Console is closed"))?
            .window_change(size.cols, size.rows, 0, 0)
            .await?;
        Ok(())
    }
    async fn close(&mut self) -> Result<()> {
        if let Some(channel) = self.0.take() {
            channel.close().await?;
        }
        Ok(())
    }
}
impl Drop for SshWriter {
    fn drop(&mut self) {
        // Best-effort cleanup if ownership is lost before the runtime starts,
        // such as a disconnect racing with console creation.
        if let Some(channel) = self.0.take() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = tokio::time::timeout(Duration::from_secs(3), channel.close()).await;
                });
            }
        }
    }
}
#[async_trait]
impl TerminalService for Connection {
    async fn open(&self, size: TerminalSize) -> Result<TerminalStream> {
        let (reader, writer) = self.terminal(size.cols, size.rows).await?.split();
        Ok(TerminalStream {
            reader: Box::new(SshReader(reader)),
            writer: Box::new(SshWriter(Some(writer))),
            resizable: true,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::directory_command;
    use base64::{engine::general_purpose::STANDARD, Engine};

    #[test]
    fn windows_directory_is_literal_and_sftp_drive_prefix_is_removed() {
        let command = directory_command("windows", "/C:/John's site/$data & files").unwrap();
        let bytes = STANDARD
            .decode(command.split_whitespace().last().unwrap())
            .unwrap();
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let script = String::from_utf16(&units).unwrap();
        assert!(command.starts_with("powershell.exe -NoLogo -NoProfile -NoExit -EncodedCommand "));
        assert_eq!(script, "try { Set-Location -LiteralPath 'C:/John''s site/$data & files' -ErrorAction Stop } catch { Write-Error $_; exit 1 }");
    }

    #[test]
    fn rejects_unknown_shells_relative_paths_and_terminal_control_characters() {
        for (provider, path) in [
            ("routeros", "/flash"),
            ("unknown", "/tmp"),
            ("linux", "relative"),
            ("windows", "C:relative"),
            ("linux", "/tmp\nwhoami"),
            ("windows", "C:/tmp\rwhoami"),
            ("linux", "/tmp\x1b[31m"),
        ] {
            assert!(directory_command(provider, path).is_err());
        }
    }

    #[test]
    fn posix_uses_a_quoted_script_and_keeps_shell_expansion_inside_it() {
        assert_eq!(
            directory_command("linux", "/srv/site").unwrap(),
            "sh -c 'cd '\\''/srv/site'\\'' && exec \"${SHELL:-/bin/sh}\" -i'"
        );
        assert_eq!(
            directory_command("linux", "/a'b").unwrap(),
            "sh -c 'cd '\\''/a'\\''\\'\\'''\\''b'\\'' && exec \"${SHELL:-/bin/sh}\" -i'"
        );
    }

    #[cfg(unix)]
    #[test]
    fn posix_shell_reaches_literal_directory_without_evaluating_path_contents() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("site ' $(touch INJECTED) ; & [data]");
        std::fs::create_dir(&path).unwrap();
        let command = directory_command("linux", path.to_str().unwrap()).unwrap();
        use std::os::unix::fs::PermissionsExt;
        let shell = temp.path().join("shell");
        std::fs::write(&shell, "#!/bin/sh\npwd\n").unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700)).unwrap();
        let output = std::process::Command::new("sh")
            .args(["-c", &command])
            .current_dir(temp.path())
            .env("SHELL", &shell)
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).unwrap().trim(),
            path.to_str().unwrap()
        );
        assert!(!temp.path().join("INJECTED").exists());
    }
}
