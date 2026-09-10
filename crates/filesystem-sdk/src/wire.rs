// SPDX-License-Identifier: MPL-2.0
//! Versioned bridge IPC over inherited anonymous pipes, never a TCP listener.
//! The parent grants exactly one filesystem root. Neither endpoint sends SSH
//! credentials, unscoped remote paths, executable paths or shell commands.
use crate::*;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    io::{self, Read, Write},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const PROTOCOL: u32 = 1;
pub const MAX_FRAME: usize = 1024 * 1024;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub version: u32,
    pub id: u64,
    pub operation: Operation,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "method", content = "params", deny_unknown_fields)]
pub enum Operation {
    Capabilities,
    Space {
        path: MountPath,
    },
    Metadata {
        path: MountPath,
    },
    Open {
        path: MountPath,
        options: FsOpenOptions,
    },
    OpenDirectory {
        path: MountPath,
    },
    ReadDirectory {
        handle: u64,
    },
    CloseDirectory {
        handle: u64,
    },
    FileMetadata {
        handle: u64,
    },
    Read {
        handle: u64,
        offset: u64,
        length: u32,
    },
    Write {
        handle: u64,
        offset: u64,
        bytes: Vec<u8>,
    },
    SetFileMetadata {
        handle: u64,
        metadata: FsSetMetadata,
    },
    Flush {
        handle: u64,
    },
    Close {
        handle: u64,
    },
    SetMetadata {
        path: MountPath,
        metadata: FsSetMetadata,
    },
    Mkdir {
        path: MountPath,
    },
    Remove {
        path: MountPath,
        directory: bool,
    },
    Rename {
        from: MountPath,
        to: MountPath,
        replace: bool,
    },
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub version: u32,
    pub id: u64,
    pub result: FsResult<Value>,
}
#[derive(Debug, Serialize, Deserialize)]
pub enum Value {
    Unit,
    Capabilities(FsCapabilities),
    Space(FsSpace),
    Metadata(FsMetadata),
    Handle(u64),
    Data(Vec<u8>),
    Entries(Vec<FsDirectoryEntry>),
}
fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}
fn encode<T: Serialize>(value: &T) -> io::Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value).map_err(|e| invalid(e.to_string()))?;
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err(invalid("Filesystem bridge frame exceeds its bound"));
    }
    Ok(bytes)
}
fn frame_length(prefix: [u8; 4]) -> io::Result<usize> {
    let size = u32::from_be_bytes(prefix) as usize;
    if size == 0 || size > MAX_FRAME {
        Err(invalid("Invalid filesystem bridge frame length"))
    } else {
        Ok(size)
    }
}
pub fn read_frame<T: DeserializeOwned>(reader: &mut impl Read) -> io::Result<T> {
    let mut prefix = [0; 4];
    reader.read_exact(&mut prefix)?;
    let mut bytes = vec![0; frame_length(prefix)?];
    reader.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes).map_err(|e| invalid(e.to_string()))
}
pub fn write_frame<T: Serialize>(writer: &mut impl Write, value: &T) -> io::Result<()> {
    let bytes = encode(value)?;
    writer.write_all(&(bytes.len() as u32).to_be_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()
}
pub async fn read_frame_async<T: DeserializeOwned>(
    reader: &mut (impl AsyncRead + Unpin),
) -> io::Result<T> {
    let mut prefix = [0; 4];
    reader.read_exact(&mut prefix).await?;
    let mut bytes = vec![0; frame_length(prefix)?];
    reader.read_exact(&mut bytes).await?;
    serde_json::from_slice(&bytes).map_err(|e| invalid(e.to_string()))
}
pub async fn write_frame_async<T: Serialize>(
    writer: &mut (impl AsyncWrite + Unpin),
    value: &T,
) -> io::Result<()> {
    let bytes = encode(value)?;
    writer
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .await?;
    writer.write_all(&bytes).await?;
    writer.flush().await
}

struct DirectoryState {
    directory: Box<dyn MountedDirectory>,
    pending: VecDeque<FsDirectoryEntry>,
    eof: bool,
}
/// Lives for one helper/root grant. IDs are never reused or shared with another
/// grant, and provider handles are released when the pipe closes.
pub struct Server {
    fs: Arc<dyn MountedFileSystem>,
    next: u64,
    files: HashMap<u64, Arc<dyn MountedFile>>,
    directories: HashMap<u64, DirectoryState>,
}
impl Server {
    pub fn new(fs: Arc<dyn MountedFileSystem>) -> Self {
        Self {
            fs,
            next: 0,
            files: HashMap::new(),
            directories: HashMap::new(),
        }
    }
    fn allocate(&mut self) -> FsResult<u64> {
        self.next = self
            .next
            .checked_add(1)
            .ok_or_else(|| FsError::new(FsErrorKind::Io, "Handle identity exhausted"))?;
        Ok(self.next)
    }
    fn file(&self, handle: u64) -> FsResult<&Arc<dyn MountedFile>> {
        self.files
            .get(&handle)
            .ok_or_else(|| FsError::new(FsErrorKind::Offline, "Unknown or closed file handle"))
    }
    pub async fn dispatch(&mut self, operation: Operation) -> FsResult<Value> {
        match operation {
            Operation::Capabilities => {
                self.fs.check_available()?;
                return Ok(Value::Capabilities(self.fs.capabilities()));
            }
            Operation::Space { path } => return Ok(Value::Space(self.fs.space(&path).await?)),
            Operation::Metadata { path } => {
                return Ok(Value::Metadata(self.fs.metadata(&path).await?))
            }
            Operation::Open { path, options } => {
                options.validate()?;
                let id = self.allocate()?;
                let file = self.fs.open(&path, options).await?;
                self.files.insert(id, file);
                return Ok(Value::Handle(id));
            }
            Operation::OpenDirectory { path } => {
                let id = self.allocate()?;
                let directory = self.fs.open_directory(&path).await?;
                self.directories.insert(
                    id,
                    DirectoryState {
                        directory,
                        pending: VecDeque::new(),
                        eof: false,
                    },
                );
                return Ok(Value::Handle(id));
            }
            Operation::ReadDirectory { handle } => {
                let state = self.directories.get_mut(&handle).ok_or_else(|| {
                    FsError::new(FsErrorKind::Offline, "Directory handle is closed")
                })?;
                if state.pending.is_empty() && !state.eof {
                    let page = state.directory.next().await?;
                    state.eof = page.is_empty();
                    state.pending.extend(page);
                }
                let take = state.pending.len().min(64);
                return Ok(Value::Entries(state.pending.drain(..take).collect()));
            }
            Operation::CloseDirectory { handle } => {
                if let Some(mut state) = self.directories.remove(&handle) {
                    state.directory.close().await?;
                }
            }
            Operation::FileMetadata { handle } => {
                return Ok(Value::Metadata(self.file(handle)?.metadata().await?))
            }
            Operation::Read {
                handle,
                offset,
                length,
            } => {
                if length as usize > MOUNT_IO_CHUNK {
                    return Err(FsError::new(
                        FsErrorKind::InvalidInput,
                        "Read exceeds chunk size",
                    ));
                }
                let data = self.file(handle)?.read_at(offset, length).await?;
                if data.len() > length as usize {
                    return Err(FsError::new(
                        FsErrorKind::Io,
                        "Provider exceeded requested read length",
                    ));
                }
                return Ok(Value::Data(data));
            }
            Operation::Write {
                handle,
                offset,
                bytes,
            } => {
                if bytes.len() > MOUNT_IO_CHUNK {
                    return Err(FsError::new(
                        FsErrorKind::InvalidInput,
                        "Write exceeds chunk size",
                    ));
                }
                self.file(handle)?.write_at(offset, &bytes).await?;
            }
            Operation::SetFileMetadata { handle, metadata } => {
                self.file(handle)?.set_metadata(metadata).await?
            }
            Operation::Flush { handle } => self.file(handle)?.flush().await?,
            Operation::Close { handle } => {
                if let Some(file) = self.files.remove(&handle) {
                    file.close().await?;
                }
            }
            Operation::SetMetadata { path, metadata } => {
                self.fs.set_metadata(&path, metadata).await?
            }
            Operation::Mkdir { path } => self.fs.mkdir(&path).await?,
            Operation::Remove { path, directory } => self.fs.remove(&path, directory).await?,
            Operation::Rename { from, to, replace } => self.fs.rename(&from, &to, replace).await?,
        }
        Ok(Value::Unit)
    }
    pub async fn close(&mut self) {
        // Bound the whole teardown, not each handle serially. A disconnected
        // server with many open files must not hold shutdown for hours.
        let files = std::mem::take(&mut self.files);
        let directories = std::mem::take(&mut self.directories);
        let _ = tokio::time::timeout(REQUEST_TIMEOUT, async move {
            let mut closing = tokio::task::JoinSet::new();
            for file in files.into_values() {
                if closing.len() == 16 {
                    let _ = closing.join_next().await;
                }
                closing.spawn(async move {
                    let _ = file.close().await;
                });
            }
            for mut dir in directories.into_values() {
                if closing.len() == 16 {
                    let _ = closing.join_next().await;
                }
                closing.spawn(async move {
                    let _ = dir.directory.close().await;
                });
            }
            while closing.join_next().await.is_some() {}
        })
        .await;
    }
    pub async fn serve(
        mut self,
        mut reader: impl AsyncRead + Unpin,
        mut writer: impl AsyncWrite + Unpin,
    ) -> io::Result<()> {
        let result = async {
            let mut last = 0;
            loop {
                let request: Request = read_frame_async(&mut reader).await?;
                if request.version != PROTOCOL || request.id <= last {
                    return Err(invalid("Invalid bridge version or request sequence"));
                }
                last = request.id;
                let result =
                    tokio::time::timeout(REQUEST_TIMEOUT, self.dispatch(request.operation)).await;
                let timed_out = result.is_err();
                let result = result.unwrap_or_else(|_| {
                    Err(FsError::new(
                        FsErrorKind::TimedOut,
                        "Filesystem request timed out; attachment is being retired",
                    ))
                });
                tokio::time::timeout(
                    REQUEST_TIMEOUT,
                    write_frame_async(
                        &mut writer,
                        &Response {
                            version: PROTOCOL,
                            id: request.id,
                            result,
                        },
                    ),
                )
                .await
                .map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Bridge stopped reading filesystem replies",
                    )
                })??;
                if timed_out {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Filesystem bridge retired after timeout",
                    ));
                }
            }
        }
        .await;
        self.close().await;
        result
    }
}

/// Blocking native callback client. No async executor or SSH implementation is
/// needed in a driver backend. Serialize complete request/reply exchanges so OS
/// callbacks from different threads cannot consume one another's replies.
pub struct Client<R, W> {
    io: Mutex<(R, W, bool)>,
    next: AtomicU64,
}
impl<R: Read, W: Write> Client<R, W> {
    pub fn new(reader: R, writer: W) -> Self {
        Self {
            io: Mutex::new((reader, writer, false)),
            next: AtomicU64::new(0),
        }
    }
    pub fn call(&self, operation: Operation) -> FsResult<Value> {
        let mut io = self
            .io
            .lock()
            .map_err(|_| FsError::new(FsErrorKind::Offline, "Bridge transport lock failed"))?;
        if io.2 {
            return Err(FsError::new(
                FsErrorKind::Offline,
                "Bridge connection is closed",
            ));
        }
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let result = (|| -> io::Result<Response> {
            write_frame(
                &mut io.1,
                &Request {
                    version: PROTOCOL,
                    id,
                    operation,
                },
            )?;
            let response: Response = read_frame(&mut io.0)?;
            if response.version != PROTOCOL || response.id != id {
                return Err(invalid("Mismatched filesystem reply"));
            }
            Ok(response)
        })();
        match result {
            Ok(response) => response.result,
            Err(e) => {
                io.2 = true;
                Err(FsError::new(FsErrorKind::Offline, e.to_string()))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn framing_rejects_oversize_and_path_traversal() {
        let mut bytes = ((MAX_FRAME + 1) as u32).to_be_bytes().as_slice().to_vec();
        assert!(read_frame::<Request>(&mut bytes.as_slice()).is_err());
        let json = br#"{"version":1,"id":1,"operation":{"method":"Metadata","params":{"path":["..","etc"]}}}"#;
        bytes = (json.len() as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(json);
        assert!(read_frame::<Request>(&mut bytes.as_slice()).is_err());
    }
    #[test]
    fn framed_requests_preserve_large_offsets() {
        let mut bytes = vec![];
        write_frame(
            &mut bytes,
            &Request {
                version: PROTOCOL,
                id: 10,
                operation: Operation::Read {
                    handle: 3,
                    offset: (1u64 << 53) + 1,
                    length: 32768,
                },
            },
        )
        .unwrap();
        let decoded: Request = read_frame(&mut bytes.as_slice()).unwrap();
        assert!(
            matches!(decoded.operation, Operation::Read { offset, .. } if offset == (1u64 << 53) + 1)
        );
    }
    #[test]
    fn mismatched_reply_retires_the_transport() {
        let mut bytes = vec![];
        write_frame(
            &mut bytes,
            &Response {
                version: PROTOCOL,
                id: 99,
                result: Ok(Value::Unit),
            },
        )
        .unwrap();
        let client = Client::new(bytes.as_slice(), vec![]);
        assert_eq!(
            client.call(Operation::Capabilities).unwrap_err().kind,
            FsErrorKind::Offline
        );
        assert_eq!(
            client.call(Operation::Capabilities).unwrap_err().kind,
            FsErrorKind::Offline
        );
    }
}
