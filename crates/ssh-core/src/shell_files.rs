// SPDX-License-Identifier: MPL-2.0
//! Optional POSIX-shell file access over separate SSH exec channels. Never uses
//! the interactive terminal, installs remote helpers, or elevates privileges.
use crate::{Connection, OP_TIMEOUT};
use anyhow::{bail, Context, Result};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine};
use russh::{client, Channel, ChannelMsg};
use shellcanvas_services::*;
use std::{collections::VecDeque, sync::Arc};
use tokio::time::timeout;

#[cfg(all(test, any(windows, target_os = "linux")))]
#[path = "shell_files_tests.rs"]
mod tests;

// GNU and BusyBox stat; include inode/device and high-resolution timestamps
// where supplied by the host. This is an optimistic revision, as with SFTP.
const STAT: &str = "stat -c '%f|%s|%Y|%d|%i|%y|%z' --";
const PROBE: &str =
    "cd -P . && printf 'SC1\\000%s\\000' \"$PWD\" && stat -c '%f|%s|%Y|%d|%i|%y|%z' -- .";
const DOWNLOAD_PROBE: &str = "command -v cat >/dev/null && exec 3</dev/null && a=$(stat -Lc '%d:%i' /proc/self/fd/3) && b=$(stat -Lc '%d:%i' /dev/null) && [ \"$a\" = \"$b\" ] && printf SCREAD";
const UPLOAD_PROBE: &str = "command -v mktemp >/dev/null && command -v rm >/dev/null && command -v ln >/dev/null && [ \"$(printf YQ== | base64 -d)\" = a ] && ln --help 2>&1";
const FIELD_LIMIT: usize = 64 * 1024;

fn quote(value: &str) -> Result<String> {
    if value.contains('\0') {
        bail!("A remote path cannot contain NUL");
    }
    Ok(format!("'{}'", value.replace('\'', "'\\''")))
}
fn absolute(path: &str) -> Result<&str> {
    if !path.starts_with('/') || path.contains('\0') {
        bail!("Shell file access requires an absolute POSIX path");
    }
    Ok(path)
}
fn child(parent: &str, name: &str) -> Result<String> {
    absolute(parent)?;
    if name.is_empty() || matches!(name, "." | "..") || name.contains(['/', '\0']) {
        bail!("Invalid remote file name");
    }
    Ok(format!("{}/{}", parent.trim_end_matches('/'), name))
}
fn location(path: String) -> FileLocation {
    crate::provider::sftp_location(path)
}
fn entry(path: String, metadata: &str) -> Result<FileEntry> {
    let fields: Vec<_> = metadata.split('|').collect();
    if fields.len() != 7 || fields.iter().any(|v| v.is_empty()) {
        bail!("Unsupported shell stat response");
    }
    let mode = u32::from_str_radix(fields[0], 16).context("Invalid file mode")?;
    let size = fields[1].parse().context("Invalid file size")?;
    let modified: i64 = fields[2].parse().context("Invalid modification time")?;
    fields[3].parse::<u64>().context("Invalid device number")?;
    fields[4].parse::<u64>().context("Invalid inode number")?;
    let kind = match mode & 0xf000 {
        0x4000 => "directory",
        0x8000 => "file",
        0xa000 => "symlink",
        _ => "special",
    };
    Ok(FileEntry {
        name: location(path.clone()).name,
        path,
        kind: kind.into(),
        size,
        modified: u32::try_from(modified).ok(),
        revision: metadata.into(),
    })
}

/// Owns the exec channel even while requests are pending, so timeout/cancellation
/// closes it. stdout is binary and bounded per delivery; stderr is bounded too.
struct Command {
    channel: Option<Channel<client::Msg>>,
    pending: VecDeque<u8>,
    stderr: Vec<u8>,
    status: Option<u32>,
    done: bool,
}
impl Command {
    async fn start(connection: &Connection, script: &str) -> Result<Self> {
        let channel = timeout(OP_TIMEOUT, connection.handle.channel_open_session())
            .await
            .context("Shell file channel timed out")??;
        let result = Self {
            channel: Some(channel),
            pending: VecDeque::new(),
            stderr: vec![],
            status: None,
            done: false,
        };
        timeout(
            OP_TIMEOUT,
            result
                .channel
                .as_ref()
                .unwrap()
                .exec(true, format!("LC_ALL=C; export LC_ALL; {script}")),
        )
        .await
        .context("Shell file command timed out")??;
        Ok(result)
    }
    async fn read(&mut self) -> Result<Vec<u8>> {
        if self.channel.is_none() {
            bail!("Shell file channel is closed");
        }
        timeout(OP_TIMEOUT, self.read_inner())
            .await
            .context("Shell file read timed out")?
    }
    async fn read_inner(&mut self) -> Result<Vec<u8>> {
        while self.pending.is_empty() && !self.done {
            match self
                .channel
                .as_mut()
                .context("Shell file channel is closed")?
                .wait()
                .await
            {
                Some(ChannelMsg::Data { data }) => self.pending.extend(data.iter()),
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    let count = data.len().min(4096 - self.stderr.len());
                    self.stderr.extend_from_slice(&data[..count]);
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => self.status = Some(exit_status),
                Some(ChannelMsg::Failure) => bail!("The host rejected shell file access"),
                Some(ChannelMsg::Close) | None => self.done = true,
                _ => {}
            }
        }
        if self.done && self.pending.is_empty() && self.status != Some(0) {
            bail!(
                "Shell file command failed (status {:?}): {}",
                self.status,
                String::from_utf8_lossy(&self.stderr).trim()
            );
        }
        Ok(self
            .pending
            .drain(..self.pending.len().min(TRANSFER_CHUNK))
            .collect())
    }
    async fn write(&self, bytes: &[u8]) -> Result<()> {
        timeout(
            OP_TIMEOUT,
            self.channel
                .as_ref()
                .context("Shell file channel is closed")?
                .data(bytes),
        )
        .await
        .context("Shell file write timed out")??;
        Ok(())
    }
    async fn close(&mut self) -> Result<()> {
        if let Some(channel) = self.channel.take() {
            timeout(OP_TIMEOUT, async {
                let _ = channel.eof().await;
                channel.close().await
            })
            .await
            .context("Shell file close timed out")??;
        }
        self.done = true;
        self.pending.clear();
        Ok(())
    }
}
impl Drop for Command {
    fn drop(&mut self) {
        if let Some(channel) = self.channel.take() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = timeout(OP_TIMEOUT, async {
                        let _ = channel.eof().await;
                        let _ = channel.close().await;
                    })
                    .await;
                });
            }
        }
    }
}
async fn collect(connection: &Connection, script: &str, limit: usize) -> Result<Vec<u8>> {
    timeout(OP_TIMEOUT, async {
        let mut command = Command::start(connection, script).await?;
        let mut bytes = Vec::new();
        loop {
            let chunk = command.read().await?;
            if chunk.is_empty() {
                break;
            }
            if chunk.len() > limit.saturating_sub(bytes.len()) {
                bail!("Shell file response exceeded its size limit");
            }
            bytes.extend(chunk);
        }
        command.close().await?;
        Ok(bytes)
    })
    .await
    .context("Shell file operation timed out")?
}

pub struct ShellFiles {
    connection: Arc<Connection>,
    home: String,
    downloads: bool,
    uploads: bool,
}
impl ShellFiles {
    /// All probing is read-only. Incompatible/restricted shells fail closed.
    pub async fn probe(connection: Arc<Connection>) -> Result<Self> {
        let bytes = collect(&connection, PROBE, FIELD_LIMIT).await?;
        let mut fields = bytes.split(|b| *b == 0);
        if fields.next() != Some(b"SC1".as_slice()) {
            bail!("The host does not provide a compatible POSIX shell");
        }
        let home = String::from_utf8(fields.next().context("Missing shell home")?.to_vec())?;
        absolute(&home)?;
        let metadata = std::str::from_utf8(fields.next().context("Missing shell stat")?)?
            .trim_end_matches('\n');
        if fields.next().is_some() || entry(home.clone(), metadata)?.kind != "directory" {
            bail!("The host does not provide compatible directory metadata");
        }
        let downloads = collect(&connection, DOWNLOAD_PROBE, FIELD_LIMIT)
            .await
            .is_ok_and(|v| v == b"SCREAD");
        let uploads = collect(&connection, UPLOAD_PROBE, FIELD_LIMIT)
            .await
            .is_ok_and(|help| String::from_utf8_lossy(&help).contains("-T"));
        Ok(Self {
            connection,
            home,
            downloads,
            uploads,
        })
    }
    pub fn home(&self) -> &str {
        &self.home
    }
    pub fn can_upload(&self) -> bool {
        self.uploads
    }
    pub fn can_download(&self) -> bool {
        self.downloads
    }
    async fn stat(&self, path: &str) -> Result<FileEntry> {
        let bytes = collect(
            &self.connection,
            &format!("{STAT} {}", quote(absolute(path)?)?),
            FIELD_LIMIT,
        )
        .await?;
        entry(
            path.into(),
            std::str::from_utf8(&bytes)?.trim_end_matches('\n'),
        )
    }
    async fn checked(&self, path: &str, revision: &str) -> Result<FileEntry> {
        let item = self.stat(path).await?;
        if item.revision != revision {
            bail!("The remote entry changed. Refresh and try again.");
        }
        Ok(item)
    }
    async fn directory_path(&self, path: &str) -> Result<String> {
        let script = format!(
            "cd -P {} && printf '%s\\000' \"$PWD\"",
            quote(absolute(path)?)?
        );
        let bytes = collect(&self.connection, &script, FIELD_LIMIT).await?;
        let path = std::str::from_utf8(
            bytes
                .strip_suffix(&[0])
                .context("Invalid shell directory response")?,
        )?;
        absolute(path)?;
        Ok(path.into())
    }
}

struct ShellDirectory {
    command: Command,
    metadata: Directory,
    buffer: Vec<u8>,
    active: bool,
}
impl ShellDirectory {
    async fn field(&mut self) -> Result<Option<String>> {
        loop {
            if let Some(end) = self.buffer.iter().position(|b| *b == 0) {
                if end > FIELD_LIMIT {
                    bail!("Shell directory field is too large");
                }
                let field = String::from_utf8(self.buffer.drain(..=end).take(end).collect())?;
                return Ok(Some(field));
            }
            if self.buffer.len() > FIELD_LIMIT {
                bail!("Shell directory field is too large");
            }
            let chunk = self.command.read().await?;
            if chunk.is_empty() {
                if !self.buffer.is_empty() {
                    bail!("Truncated shell directory response");
                }
                return Ok(None);
            }
            self.buffer.extend(chunk);
        }
    }
    async fn page(&mut self) -> Result<DirectoryPage> {
        let mut directory = self.metadata.clone();
        while directory.entries.len() < DIRECTORY_PAGE {
            let Some(name) = self.field().await? else {
                return Ok(DirectoryPage {
                    directory,
                    done: true,
                });
            };
            let metadata = self
                .field()
                .await?
                .context("Truncated shell directory entry")?;
            directory
                .entries
                .push(entry(child(&directory.path, &name)?, &metadata)?);
        }
        Ok(DirectoryPage {
            directory,
            done: false,
        })
    }
}
#[async_trait]
impl DirectoryReader for ShellDirectory {
    async fn next(&mut self) -> Result<DirectoryPage> {
        if !self.active {
            bail!("Directory reader is closed");
        }
        self.active = false;
        let result = timeout(OP_TIMEOUT, self.page())
            .await
            .context("Shell directory page timed out")
            .and_then(|v| v);
        match result {
            Ok(page) => {
                if page.done {
                    self.command.close().await?;
                } else {
                    self.active = true;
                }
                Ok(page)
            }
            Err(error) => {
                let _ = self.close().await;
                Err(error)
            }
        }
    }
    async fn close(&mut self) -> Result<()> {
        self.active = false;
        self.buffer.clear();
        self.command.close().await
    }
}
#[async_trait]
impl FileSystemProvider for ShellFiles {
    async fn list(&self, path: Option<&str>) -> Result<Directory> {
        collect_directory(self.open(path).await?).await
    }
    async fn open_directory(
        self: Arc<Self>,
        path: Option<&str>,
    ) -> Result<Box<dyn DirectoryReader>> {
        self.open(path).await
    }
    async fn locate(&self, path: &str) -> Result<FileLocation> {
        let item = self.stat(path).await?;
        if item.kind == "directory" {
            Ok(location(self.directory_path(path).await?))
        } else {
            Ok(location(path.into()))
        }
    }
    async fn preview(&self, path: &str) -> Result<String> {
        Ok(self.read_text(path).await?.text)
    }
}
impl ShellFiles {
    async fn open(&self, path: Option<&str>) -> Result<Box<dyn DirectoryReader>> {
        let path = self.directory_path(path.unwrap_or(&self.home)).await?;
        let place = location(path.clone());
        // NUL framing preserves whitespace, newlines and shell metacharacters.
        // Unmatched globs are skipped; never parse human-readable ls output.
        let script = format!("cd {} || exit; [ -r . ] && [ -x . ] || exit 1; for f in .[!.]* ..?* *; do [ -e \"$f\" ] || [ -L \"$f\" ] || continue; m=$({STAT} \"./$f\") || exit; printf '%s\\000%s\\000' \"$f\" \"$m\"; done", quote(&path)?);
        Ok(Box::new(ShellDirectory {
            command: Command::start(&self.connection, &script).await?,
            metadata: Directory {
                path,
                name: place.name,
                parent: place.parent,
                home: Some(FilePlace {
                    path: self.home.clone(),
                    name: location(self.home.clone()).name,
                }),
                roots: vec![FilePlace {
                    path: "/".into(),
                    name: "/".into(),
                }],
                entries: vec![],
            },
            buffer: vec![],
            active: true,
        }))
    }
}

fn download_script(path: &str, revision: &str) -> Result<String> {
    let path = quote(absolute(path)?)?;
    let revision = quote(revision)?;
    // Bind the read to an opened regular file; Linux procfs lets stat verify
    // the actual descriptor as well as the path before and after the stream.
    Ok(format!("p={path}; r={revision}; [ ! -L \"$p\" ] && [ -f \"$p\" ] || exit 1; exec 3<\"$p\" || exit; [ \"$(stat -Lc '%f|%s|%Y|%d|%i|%y|%z' /proc/self/fd/3)\" = \"$r\" ] || exit 1; cat <&3 || exit; [ \"$({STAT} \"$p\")\" = \"$r\" ] && [ \"$(stat -Lc '%f|%s|%Y|%d|%i|%y|%z' /proc/self/fd/3)\" = \"$r\" ]"))
}
struct Download {
    command: Command,
    file: TransferFile,
    read: u64,
    eof: bool,
}
#[async_trait]
impl TransferReader for Download {
    fn file(&self) -> TransferFile {
        self.file.clone()
    }
    async fn read(&mut self) -> Result<Vec<u8>> {
        let bytes = self.command.read().await?;
        self.read += bytes.len() as u64;
        if self.read > self.file.size {
            bail!("Remote file grew during download");
        }
        self.eof = bytes.is_empty();
        Ok(bytes)
    }
    async fn finish(&mut self) -> Result<()> {
        if self.command.channel.is_none() {
            bail!("Download is closed");
        }
        if !self.eof && !self.read().await?.is_empty() {
            bail!("Download has unread data");
        }
        if self.read != self.file.size {
            bail!("Remote file was truncated during download");
        }
        self.command.close().await
    }
    async fn abort(&mut self) -> Result<()> {
        self.command.close().await
    }
}

fn upload_script(parent: &str, name: &str, size: u64) -> Result<String> {
    let destination = quote(&child(parent, name)?)?;
    let template = quote(&child(parent, ".shellcanvas-upload.XXXXXXXXXXXX")?)?;
    // EOF is cancellation, not publication. Only an explicit commit after all
    // chunks publishes via no-clobber hard link; -T also rejects directories.
    // A shell EXIT trap removes only the private mktemp file on every path.
    Ok(format!("umask 077; t=$(mktemp {template}) || exit; trap 'rm -f -- \"$t\" || exit 1' 0; trap 'exit 1' 1 2 15; printf 'SCREADY\\n'; while IFS= read -r chunk; do if [ \"$chunk\" = ABORT ]; then exit 0; fi; if [ \"$chunk\" = COMMIT ]; then [ \"$(stat -c %s -- \"$t\")\" = {size} ] || exit 1; ln -T -- \"$t\" {destination} || exit; exit 0; fi; printf '%s' \"$chunk\" | base64 -d >> \"$t\" || exit; done; exit 1"))
}
struct Upload {
    command: Command,
    destination: FileLocation,
    size: u64,
    written: u64,
    active: bool,
}
#[async_trait]
impl TransferWriter for Upload {
    async fn write(&mut self, bytes: &[u8]) -> Result<()> {
        if !self.active
            || bytes.len() > TRANSFER_CHUNK
            || bytes.len() as u64 > self.size - self.written
        {
            bail!("Invalid shell upload chunk or closed upload");
        }
        self.active = false;
        let mut line = STANDARD.encode(bytes);
        line.push('\n');
        self.command.write(line.as_bytes()).await?;
        self.written += bytes.len() as u64;
        self.active = true;
        Ok(())
    }
    async fn finish(&mut self) -> Result<FileLocation> {
        if !self.active || self.written != self.size {
            bail!("Upload is incomplete or closed");
        }
        self.active = false;
        async {
            self.command.write(b"COMMIT\n").await?;
            if !self.command.read().await?.is_empty() {
                bail!("Unexpected shell upload response");
            }
            self.command.close().await
        }
        .await
        .context(
            "Upload completion could not be confirmed. Refresh the destination before retrying",
        )?;
        Ok(self.destination.clone())
    }
    async fn abort(&mut self) -> Result<()> {
        let cleanup = if self.active {
            self.active = false;
            async {
                self.command.write(b"ABORT\n").await?;
                if !self.command.read().await?.is_empty() {
                    bail!("Unexpected shell upload cleanup response");
                }
                Ok::<_, anyhow::Error>(())
            }
            .await
        } else {
            Ok(())
        };
        self.active = false;
        let close = self.command.close().await;
        cleanup.context("Shell upload cleanup could not be confirmed")?;
        close
    }
}
#[async_trait]
impl FileTransferService for ShellFiles {
    async fn download(
        self: Arc<Self>,
        path: &str,
        revision: &str,
    ) -> Result<Box<dyn TransferReader>> {
        if !self.downloads {
            bail!("Safe shell downloads are unavailable on this host");
        }
        let item = self.checked(path, revision).await?;
        if item.kind != "file" {
            bail!("Shell transfers support regular files only");
        }
        Ok(Box::new(Download {
            command: Command::start(&self.connection, &download_script(path, revision)?).await?,
            file: TransferFile {
                location: location(path.into()),
                size: item.size,
            },
            read: 0,
            eof: false,
        }))
    }
    async fn upload(
        self: Arc<Self>,
        parent: &str,
        name: &str,
        size: u64,
    ) -> Result<Box<dyn TransferWriter>> {
        if !self.uploads {
            bail!("Safe shell uploads are unavailable on this host");
        }
        let parent = self.directory_path(parent).await?;
        let mut command =
            Command::start(&self.connection, &upload_script(&parent, name, size)?).await?;
        let mut ready = Vec::new();
        timeout(OP_TIMEOUT, async {
            while ready.len() < 8 {
                let chunk = command.read().await?;
                if chunk.is_empty() {
                    bail!("Shell upload did not start");
                }
                ready.extend(chunk);
            }
            if ready != b"SCREADY\n" {
                bail!("Unexpected shell upload handshake");
            }
            Ok::<_, anyhow::Error>(())
        })
        .await
        .context("Shell upload preparation timed out")??;
        Ok(Box::new(Upload {
            command,
            destination: location(child(&parent, name)?),
            size,
            written: 0,
            active: true,
        }))
    }
}
#[async_trait]
impl TextFileService for ShellFiles {
    async fn read_text(&self, path: &str) -> Result<TextDocument> {
        if !self.downloads {
            bail!("Text preview is unavailable on this host");
        }
        let item = self.stat(path).await?;
        if item.kind != "file" || item.size > 256 * 1024 {
            bail!("Shell text preview supports regular files up to 256 KiB");
        }
        let bytes = collect(
            &self.connection,
            &download_script(path, &item.revision)?,
            256 * 1024,
        )
        .await?;
        if bytes.len() as u64 != item.size || bytes.contains(&0) {
            bail!("File changed or is not a text file");
        }
        let place = location(path.into());
        Ok(TextDocument {
            path: place.path,
            name: place.name,
            parent: place.parent,
            text: String::from_utf8(bytes).context("File is not UTF-8 text")?,
            revision: item.revision,
            writable: false,
            save_requires_confirmation: false,
        })
    }
    async fn create_text(&self, _: &str, _: &str, _: &str) -> Result<TextDocument> {
        bail!("Text editing is unavailable in shell file mode")
    }
    async fn save_text(&self, _: &str, _: &str, _: &str) -> Result<TextDocument> {
        bail!("Text editing is unavailable in shell file mode")
    }
}
