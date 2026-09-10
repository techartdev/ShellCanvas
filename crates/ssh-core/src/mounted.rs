// SPDX-License-Identifier: MPL-2.0
//! SFTP implementation of the optional native mount service. No remote agent.
use crate::{SftpBrowser, SftpTextFiles, OP_TIMEOUT};
use async_trait::async_trait;
use russh_sftp::{
    client::error::Error as SftpError,
    protocol::{FileAttributes, OpenFlags, StatusCode},
};
use shellcanvas_services::*;
use std::{future::Future, sync::Arc};
use tokio::sync::RwLock;

fn error(e: SftpError) -> FsError {
    let kind = match &e {
        SftpError::Status(s) => match s.status_code {
            StatusCode::NoSuchFile => FsErrorKind::NotFound,
            StatusCode::PermissionDenied => FsErrorKind::PermissionDenied,
            StatusCode::NoConnection | StatusCode::ConnectionLost => FsErrorKind::Offline,
            StatusCode::OpUnsupported => FsErrorKind::Unsupported,
            _ => FsErrorKind::Io,
        },
        SftpError::Timeout => FsErrorKind::TimedOut,
        _ => FsErrorKind::Io,
    };
    FsError::new(kind, e.to_string())
}
async fn request<T>(f: impl Future<Output = Result<T, SftpError>>) -> FsResult<T> {
    tokio::time::timeout(OP_TIMEOUT, f)
        .await
        .map_err(|_| {
            FsError::new(
                FsErrorKind::TimedOut,
                "Remote filesystem request timed out; a write may have completed",
            )
        })?
        .map_err(error)
}
async fn acquire_handle(
    service: &SftpTextFiles,
    operation: impl Future<Output = Result<russh_sftp::protocol::Handle, SftpError>>,
) -> FsResult<String> {
    match request(operation).await {
        Ok(handle) => Ok(handle.handle),
        Err(error) => {
            if error.kind == FsErrorKind::TimedOut {
                // The remote server may have allocated a handle whose reply was
                // lost or late. No handle ID means we cannot send CLOSE. Retire
                // this mount's dedicated SFTP channel so the server releases it.
                // Never retry OPEN: CREATE could already have changed the source.
                service
                    .channel_closed
                    .store(true, std::sync::atomic::Ordering::Release);
                let _ = service.raw.close_session();
            }
            Err(error)
        }
    }
}
fn metadata(a: FileAttributes) -> FsMetadata {
    FsMetadata {
        kind: if a.is_dir() {
            FsKind::Directory
        } else if a.is_regular() {
            FsKind::File
        } else if a.is_symlink() {
            FsKind::Symlink
        } else {
            FsKind::Other
        },
        size: a.size.unwrap_or(0),
        accessed: a.atime.map(u64::from),
        modified: a.mtime.map(u64::from),
        permissions: a.permissions,
    }
}
fn writable(enabled: bool) -> FsResult<()> {
    if enabled {
        Ok(())
    } else {
        Err(FsError::new(
            FsErrorKind::ReadOnly,
            "This attachment is read-only",
        ))
    }
}
fn mutable_path(path: &MountPath) -> FsResult<()> {
    if path.components().is_empty() {
        Err(FsError::new(
            FsErrorKind::PermissionDenied,
            "The attachment root cannot be removed or replaced",
        ))
    } else {
        Ok(())
    }
}
fn regular(a: &FileAttributes) -> FsResult<()> {
    if a.is_regular() {
        Ok(())
    } else {
        Err(FsError::new(
            if a.is_dir() {
                FsErrorKind::IsDirectory
            } else {
                FsErrorKind::Unsupported
            },
            "Only regular files can be opened through this attachment",
        ))
    }
}
fn attributes(update: FsSetMetadata, current: FileAttributes) -> FsResult<FileAttributes> {
    let mut attrs = FileAttributes::empty();
    attrs.size = update.size;
    attrs.permissions = update.permissions.map(|p| p & 0o777);
    // SFTP v3 changes access and modification time as a pair. Preserve the
    // unspecified side, and refuse timestamps the protocol cannot represent.
    if update.accessed.is_some() || update.modified.is_some() {
        let convert = |value: Option<u64>| {
            value.and_then(|v| u32::try_from(v).ok()).ok_or_else(|| {
                FsError::new(
                    FsErrorKind::Unsupported,
                    "Timestamp is unavailable or outside the SFTP v3 range",
                )
            })
        };
        attrs.atime = Some(convert(update.accessed.or(current.atime.map(u64::from)))?);
        attrs.mtime = Some(convert(update.modified.or(current.mtime.map(u64::from)))?);
    }
    Ok(attrs)
}

pub struct SftpMount {
    service: Arc<SftpTextFiles>,
    root: String,
    writable: bool,
    connection: Option<Arc<dyn ConnectionLifecycle>>,
}
impl SftpMount {
    pub async fn new(service: Arc<SftpTextFiles>, path: &str, write: bool) -> FsResult<Arc<Self>> {
        Self::prepare(service, path, write, None).await
    }
    pub(crate) async fn connected(
        service: Arc<SftpTextFiles>,
        path: &str,
        write: bool,
        connection: Arc<dyn ConnectionLifecycle>,
    ) -> FsResult<Arc<Self>> {
        Self::prepare(service, path, write, Some(connection)).await
    }
    async fn prepare(
        service: Arc<SftpTextFiles>,
        path: &str,
        write: bool,
        connection: Option<Arc<dyn ConnectionLifecycle>>,
    ) -> FsResult<Arc<Self>> {
        let root = SftpBrowser(service.clone())
            .canonicalize(path)
            .await
            .map_err(|e| FsError::new(FsErrorKind::Io, e.to_string()))?;
        if !request(service.raw.lstat(&root)).await?.attrs.is_dir() {
            return Err(FsError::new(
                FsErrorKind::NotDirectory,
                "Select a remote directory",
            ));
        }
        Ok(Arc::new(Self {
            service,
            root,
            writable: write,
            connection,
        }))
    }
    /// Walk components without following links. SFTP v3 has no openat/nofollow
    /// primitive: this rejects observed links, not concurrent server-side path
    /// replacement. The authenticated account remains the server security bound.
    async fn resolve(&self, path: &MountPath, absent_leaf: bool) -> FsResult<String> {
        let mut result = self.root.clone();
        let root_attrs = request(self.service.raw.lstat(&result)).await?.attrs;
        if !root_attrs.is_dir() {
            return Err(FsError::new(
                FsErrorKind::NotDirectory,
                "Attachment root changed",
            ));
        }
        for (index, name) in path.components().iter().enumerate() {
            result = format!("{}/{name}", result.trim_end_matches('/'));
            let last = index + 1 == path.components().len();
            match request(self.service.raw.lstat(&result)).await {
                Ok(a) => {
                    if a.attrs.is_symlink() || !(a.attrs.is_dir() || a.attrs.is_regular()) {
                        return Err(FsError::new(
                            FsErrorKind::Unsupported,
                            "Links and special files are not exposed by this attachment",
                        ));
                    }
                    if !last && !a.attrs.is_dir() {
                        return Err(FsError::new(
                            FsErrorKind::NotDirectory,
                            "A path component is not a directory",
                        ));
                    }
                }
                Err(e) if last && absent_leaf && e.kind == FsErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        Ok(result)
    }
}

struct RemoteHandle {
    service: Arc<SftpTextFiles>,
    id: RwLock<Option<String>>,
}
impl RemoteHandle {
    async fn close(&self) -> FsResult<()> {
        let mut id = self.id.write().await;
        if let Some(id) = id.take() {
            request(self.service.raw.close(id)).await?;
        }
        Ok(())
    }
}
impl Drop for RemoteHandle {
    fn drop(&mut self) {
        if let Some(id) = self.id.get_mut().take() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                let service = self.service.clone();
                runtime.spawn(async move {
                    let _ = request(service.raw.close(id)).await;
                });
            }
        }
    }
}
fn closed() -> FsError {
    FsError::new(FsErrorKind::Offline, "Remote file handle is closed")
}
struct RemoteFile {
    handle: RemoteHandle,
    read: bool,
    write: bool,
    metadata_writable: bool,
}
#[async_trait]
impl MountedFile for RemoteFile {
    async fn metadata(&self) -> FsResult<FsMetadata> {
        let id = self.handle.id.read().await;
        Ok(metadata(
            request(
                self.handle
                    .service
                    .raw
                    .fstat(id.as_ref().ok_or_else(closed)?),
            )
            .await?
            .attrs,
        ))
    }
    async fn read_at(&self, offset: u64, length: u32) -> FsResult<Vec<u8>> {
        if !self.read {
            return Err(FsError::new(
                FsErrorKind::PermissionDenied,
                "Handle was not opened for reading",
            ));
        }
        if length as usize > MOUNT_IO_CHUNK || offset.checked_add(u64::from(length)).is_none() {
            return Err(FsError::new(
                FsErrorKind::InvalidInput,
                "Invalid read range",
            ));
        }
        if length == 0 {
            return Ok(vec![]);
        }
        let id = self.handle.id.read().await;
        let operation =
            self.handle
                .service
                .raw
                .read(id.as_ref().ok_or_else(closed)?, offset, length);
        match tokio::time::timeout(OP_TIMEOUT, operation).await {
            Ok(Ok(data)) if data.data.len() <= length as usize => Ok(data.data.to_vec()),
            Ok(Ok(_)) => Err(FsError::new(
                FsErrorKind::Io,
                "Server exceeded the read length",
            )),
            Ok(Err(SftpError::Status(s))) if s.status_code == StatusCode::Eof => Ok(vec![]),
            Ok(Err(e)) => Err(error(e)),
            Err(_) => Err(FsError::new(FsErrorKind::TimedOut, "Remote read timed out")),
        }
    }
    async fn write_at(&self, offset: u64, bytes: &[u8]) -> FsResult<()> {
        writable(self.write)?;
        if bytes.len() > MOUNT_IO_CHUNK || offset.checked_add(bytes.len() as u64).is_none() {
            return Err(FsError::new(
                FsErrorKind::InvalidInput,
                "Invalid write range",
            ));
        }
        let id = self.handle.id.read().await;
        request(self.handle.service.raw.write(
            id.as_ref().ok_or_else(closed)?,
            offset,
            bytes.to_vec(),
        ))
        .await?;
        Ok(())
    }
    async fn set_metadata(&self, update: FsSetMetadata) -> FsResult<()> {
        writable(self.metadata_writable)?;
        if update.size.is_some() {
            writable(self.write)?;
        }
        let id = self.handle.id.read().await;
        let id = id.as_ref().ok_or_else(closed)?;
        let current = request(self.handle.service.raw.fstat(id)).await?.attrs;
        request(
            self.handle
                .service
                .raw
                .fsetstat(id, attributes(update, current)?),
        )
        .await?;
        Ok(())
    }
    async fn flush(&self) -> FsResult<()> {
        let id = self.handle.id.read().await;
        let id = id.as_ref().ok_or_else(closed)?;
        if self.write && self.handle.service.fsync {
            tokio::time::timeout(
                OP_TIMEOUT,
                self.handle.service.extension("fsync@openssh.com", &[id]),
            )
            .await
            .map_err(|_| FsError::new(FsErrorKind::TimedOut, "Remote flush timed out"))?
            .map_err(|e| FsError::new(FsErrorKind::Io, e.to_string()))?;
        }
        Ok(())
    }
    async fn close(&self) -> FsResult<()> {
        self.handle.close().await
    }
}

struct RemoteDirectory {
    handle: RemoteHandle,
    eof: bool,
}
#[async_trait]
impl MountedDirectory for RemoteDirectory {
    async fn next(&mut self) -> FsResult<Vec<FsDirectoryEntry>> {
        if self.eof {
            return Ok(vec![]);
        }
        loop {
            let id = self.handle.id.read().await;
            let result = tokio::time::timeout(
                OP_TIMEOUT,
                self.handle
                    .service
                    .raw
                    .readdir(id.as_ref().ok_or_else(closed)?),
            )
            .await;
            match result {
                Ok(Ok(names)) => {
                    let entries: Vec<_> = names
                        .files
                        .into_iter()
                        .filter(|f| {
                            MountPath::root().child(&f.filename).is_ok()
                                && (f.attrs.is_dir() || f.attrs.is_regular())
                        })
                        .map(|f| FsDirectoryEntry {
                            name: f.filename,
                            metadata: metadata(f.attrs),
                        })
                        .collect();
                    if !entries.is_empty() {
                        return Ok(entries);
                    }
                }
                Ok(Err(SftpError::Status(s))) if s.status_code == StatusCode::Eof => {
                    self.eof = true;
                    return Ok(vec![]);
                }
                Ok(Err(e)) => return Err(error(e)),
                Err(_) => {
                    return Err(FsError::new(
                        FsErrorKind::TimedOut,
                        "Remote directory read timed out",
                    ))
                }
            }
        }
    }
    async fn close(&mut self) -> FsResult<()> {
        self.eof = true;
        self.handle.close().await
    }
}

#[async_trait]
impl MountedFileSystem for SftpMount {
    fn check_available(&self) -> FsResult<()> {
        if self
            .service
            .channel_closed
            .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err(FsError::new(
                FsErrorKind::Offline,
                "The attachment's SFTP channel has closed",
            ));
        }
        if self.connection.as_ref().is_some_and(|c| !c.is_connected()) {
            return Err(FsError::new(
                FsErrorKind::Offline,
                "The attachment's SSH connection has closed",
            ));
        }
        Ok(())
    }
    async fn space(&self, path: &MountPath) -> FsResult<FsSpace> {
        let path = self.resolve(path, false).await?;
        let stats = request(self.service.raw.statvfs(path)).await?;
        Ok(FsSpace {
            block_size: stats.fragment_size,
            blocks: stats.blocks,
            blocks_free: stats.blocks_free,
            blocks_available: stats.blocks_avail,
            files: stats.inodes,
            files_free: stats.inodes_free,
            name_max: stats.name_max,
        })
    }
    fn capabilities(&self) -> FsCapabilities {
        FsCapabilities {
            writable: self.writable,
            atomic_replace: self.service.can_save(),
            durable_flush: self.service.fsync,
        }
    }
    async fn metadata(&self, path: &MountPath) -> FsResult<FsMetadata> {
        let path = self.resolve(path, false).await?;
        Ok(metadata(request(self.service.raw.lstat(path)).await?.attrs))
    }
    async fn open(
        &self,
        path: &MountPath,
        options: FsOpenOptions,
    ) -> FsResult<Arc<dyn MountedFile>> {
        options.validate()?;
        if options.write {
            writable(self.writable)?;
        }
        let path = self
            .resolve(path, options.create != FsCreate::OpenExisting)
            .await?;
        match request(self.service.raw.lstat(&path)).await {
            Ok(a) => {
                if options.create == FsCreate::CreateNew {
                    return Err(FsError::new(
                        FsErrorKind::AlreadyExists,
                        "File already exists",
                    ));
                }
                regular(&a.attrs)?;
            }
            Err(e)
                if e.kind == FsErrorKind::NotFound && options.create != FsCreate::OpenExisting => {}
            Err(e) => return Err(e),
        }
        let mut flags = OpenFlags::empty();
        if options.read {
            flags |= OpenFlags::READ;
        }
        if options.write {
            flags |= OpenFlags::WRITE;
        }
        if options.create != FsCreate::OpenExisting {
            flags |= OpenFlags::CREATE;
        }
        if options.create == FsCreate::CreateNew {
            flags |= OpenFlags::EXCLUDE;
        }
        // Truncate only after validating the returned handle is a regular file.
        let service = self.service.clone();
        let metadata_writable = self.writable;
        let file = tokio::spawn(async move {
            let id = acquire_handle(
                &service,
                service.raw.open(path, flags, FileAttributes::empty()),
            )
            .await?;
            let file = RemoteFile {
                handle: RemoteHandle {
                    service,
                    id: RwLock::new(Some(id)),
                },
                read: options.read,
                write: options.write,
                metadata_writable,
            };
            if file.metadata().await?.kind != FsKind::File {
                return Err(FsError::new(
                    FsErrorKind::Unsupported,
                    "Opened object is not a regular file",
                ));
            }
            if options.truncate {
                file.set_metadata(FsSetMetadata {
                    size: Some(0),
                    ..Default::default()
                })
                .await?;
            }
            Ok::<_, FsError>(Arc::new(file) as Arc<dyn MountedFile>)
        })
        .await
        .map_err(|e| FsError::new(FsErrorKind::Io, e.to_string()))??;
        Ok(file)
    }
    async fn open_directory(&self, path: &MountPath) -> FsResult<Box<dyn MountedDirectory>> {
        let path = self.resolve(path, false).await?;
        if !request(self.service.raw.lstat(&path)).await?.attrs.is_dir() {
            return Err(FsError::new(FsErrorKind::NotDirectory, "Not a directory"));
        }
        let service = self.service.clone();
        tokio::spawn(async move {
            let id = acquire_handle(&service, service.raw.opendir(path)).await?;
            Ok(Box::new(RemoteDirectory {
                handle: RemoteHandle {
                    service,
                    id: RwLock::new(Some(id)),
                },
                eof: false,
            }) as Box<dyn MountedDirectory>)
        })
        .await
        .map_err(|e| FsError::new(FsErrorKind::Io, e.to_string()))?
    }
    async fn set_metadata(&self, path: &MountPath, update: FsSetMetadata) -> FsResult<()> {
        writable(self.writable)?;
        let path = self.resolve(path, false).await?;
        let current = request(self.service.raw.lstat(&path)).await?.attrs;
        if update.size.is_some() {
            regular(&current)?;
        }
        request(self.service.raw.setstat(path, attributes(update, current)?)).await?;
        Ok(())
    }
    async fn mkdir(&self, path: &MountPath) -> FsResult<()> {
        writable(self.writable)?;
        mutable_path(path)?;
        let path = self.resolve(path, true).await?;
        match request(self.service.raw.lstat(&path)).await {
            Ok(_) => {
                return Err(FsError::new(
                    FsErrorKind::AlreadyExists,
                    "Directory already exists",
                ))
            }
            Err(e) if e.kind == FsErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        request(self.service.raw.mkdir(path, FileAttributes::empty())).await?;
        Ok(())
    }
    async fn remove(&self, path: &MountPath, directory: bool) -> FsResult<()> {
        writable(self.writable)?;
        mutable_path(path)?;
        let path = self.resolve(path, false).await?;
        let a = request(self.service.raw.lstat(&path)).await?.attrs;
        if directory {
            if !a.is_dir() {
                return Err(FsError::new(FsErrorKind::NotDirectory, "Not a directory"));
            }
            request(self.service.raw.rmdir(path)).await?;
        } else {
            regular(&a)?;
            request(self.service.raw.remove(path)).await?;
        }
        Ok(())
    }
    async fn rename(&self, from: &MountPath, to: &MountPath, replace: bool) -> FsResult<()> {
        writable(self.writable)?;
        mutable_path(from)?;
        mutable_path(to)?;
        let from = self.resolve(from, false).await?;
        let to = self.resolve(to, true).await?;
        if from == to {
            return Ok(());
        }
        if replace {
            if !self.service.can_save() {
                return Err(FsError::new(
                    FsErrorKind::Unsupported,
                    "Server does not support atomic replacement",
                ));
            }
            tokio::time::timeout(
                OP_TIMEOUT,
                self.service
                    .extension("posix-rename@openssh.com", &[&from, &to]),
            )
            .await
            .map_err(|_| {
                FsError::new(
                    FsErrorKind::TimedOut,
                    "Rename timed out; check the destination before retrying",
                )
            })?
            .map_err(|e| FsError::new(FsErrorKind::Io, e.to_string()))?;
        } else {
            match request(self.service.raw.lstat(&to)).await {
                Ok(_) => {
                    return Err(FsError::new(
                        FsErrorKind::AlreadyExists,
                        "Destination already exists",
                    ))
                }
                Err(e) if e.kind == FsErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
            request(self.service.raw.rename(from, to)).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod acquisition_tests {
    use super::*;
    use russh_sftp::client::RawSftpSession;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

    async fn packet(stream: &mut DuplexStream) -> Vec<u8> {
        let length = stream.read_u32().await.unwrap();
        assert!(length < 4096);
        let mut bytes = vec![0; length as usize];
        stream.read_exact(&mut bytes).await.unwrap();
        bytes
    }

    async fn live_channel() -> (
        Arc<SftpTextFiles>,
        tokio::sync::oneshot::Sender<()>,
        tokio::task::JoinHandle<()>,
    ) {
        let (client, mut remote) = tokio::io::duplex(4096);
        let (close, closing) = tokio::sync::oneshot::channel();
        let peer = tokio::spawn(async move {
            assert_eq!(packet(&mut remote).await[0], 1);
            remote
                .write_all(&[0, 0, 0, 5, 2, 0, 0, 0, 3])
                .await
                .unwrap();
            let _ = closing.await;
            // Remote EOF without an outstanding filesystem request.
            drop(remote);
        });
        let service = Arc::new(SftpTextFiles::from_stream(client).await.unwrap());
        (service, close, peer)
    }

    #[tokio::test]
    async fn idle_channel_eof_retires_only_its_mount_heartbeat() {
        use shellcanvas_filesystem_sdk::wire::{Operation, Server};
        let (service_a, close_a, peer_a) = live_channel().await;
        let (service_b, close_b, peer_b) = live_channel().await;
        let server = |service| {
            Server::new(Arc::new(SftpMount {
                service,
                root: "/fixture".into(),
                writable: false,
                connection: None,
            }))
        };
        let mut a = server(service_a);
        let mut b = server(service_b);
        assert!(a.dispatch(Operation::Poll).await.is_ok());
        assert!(b.dispatch(Operation::Poll).await.is_ok());
        close_a.send(()).unwrap();
        peer_a.await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if let Err(error) = a.dispatch(Operation::Poll).await {
                    assert_eq!(error.kind, FsErrorKind::Offline);
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("Idle SFTP EOF was invisible to the heartbeat");
        assert!(
            b.dispatch(Operation::Poll).await.is_ok(),
            "Another channel was retired"
        );
        close_b.send(()).unwrap();
        peer_b.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn unconfirmed_file_and_directory_opens_close_the_dedicated_channel() {
        // Exercise the actual SFTP request path with both the library's own
        // deadline and our outer deadline. Keep the service alive throughout:
        // cleanup must be caused by failed acquisition, not its final Drop.
        for (directory, library_deadline) in [(false, 120), (true, 120), (false, 1)] {
            let (client, mut remote) = tokio::io::duplex(4096);
            let peer = tokio::spawn(async move {
                assert_eq!(packet(&mut remote).await[0], 1); // SSH_FXP_INIT
                remote
                    .write_all(&[0, 0, 0, 5, 2, 0, 0, 0, 3])
                    .await
                    .unwrap();
                let open = packet(&mut remote).await;
                assert_eq!(open[0], if directory { 11 } else { 3 });
                // Simulate an allocated remote handle with its reply delayed.
                // Session EOF is the only way to release an ID the client lacks.
                let mut byte = [0];
                let n = remote.read(&mut byte).await.unwrap();
                assert_eq!(n, 0, "Timed-out OPEN did not close its SFTP channel");
            });
            let raw = RawSftpSession::new(client);
            raw.set_timeout(library_deadline);
            let service = SftpTextFiles::new(raw).await.unwrap();
            let result = if directory {
                acquire_handle(&service, service.raw.opendir("/fixture")).await
            } else {
                acquire_handle(
                    &service,
                    service
                        .raw
                        .open("/fixture", OpenFlags::READ, FileAttributes::empty()),
                )
                .await
            };
            assert_eq!(result.unwrap_err().kind, FsErrorKind::TimedOut);
            assert!(
                service
                    .channel_closed
                    .load(std::sync::atomic::Ordering::Acquire),
                "Timed-out handle acquisition left the mount heartbeat healthy"
            );
            tokio::time::timeout(std::time::Duration::from_secs(1), peer)
                .await
                .expect("Unclaimed remote handle channel stayed open")
                .unwrap();
            drop(service);
        }
    }
}
