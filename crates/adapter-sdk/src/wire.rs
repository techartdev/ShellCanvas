// SPDX-License-Identifier: MPL-2.0
//! Adapter protocol v1: big-endian u32 byte length followed by UTF-8 JSON.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// A frame limit, not a file/tree/stream size limit. Bulk services must page/chunk.
pub const MAX_FRAME: usize = 4 * 1024 * 1024;
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Envelope {
    Request {
        v: u8,
        id: u64,
        method: String,
        params: Value,
    },
    Cancel {
        v: u8,
        id: u64,
    },
    Result {
        v: u8,
        id: u64,
        value: Value,
    },
    Error {
        v: u8,
        id: u64,
        code: String,
        message: String,
    },
}
pub fn encode(message: &Envelope) -> io::Result<Vec<u8>> {
    struct Capped(Vec<u8>);
    impl io::Write for Capped {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if bytes.len() > MAX_FRAME - self.0.len() {
                return Err(io::Error::other(
                    "Adapter frame exceeds the stream envelope limit",
                ));
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut output = Capped(Vec::new());
    serde_json::to_writer(&mut output, message).map_err(io::Error::other)?;
    Ok(output.0)
}
pub async fn read_frame(reader: &mut (impl AsyncRead + Unpin)) -> io::Result<Envelope> {
    read_frame_or_eof(reader)
        .await?
        .ok_or_else(|| io::Error::from(io::ErrorKind::UnexpectedEof))
}
/// Distinguishes a clean pipe close from a truncated header or body.
pub async fn read_frame_or_eof(
    reader: &mut (impl AsyncRead + Unpin),
) -> io::Result<Option<Envelope>> {
    let first = match reader.read_u8().await {
        Ok(first) => first,
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut prefix = [first, 0, 0, 0];
    reader.read_exact(&mut prefix[1..]).await?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(io::Error::other("Invalid adapter frame length"));
    }
    let mut data = vec![0; length];
    reader.read_exact(&mut data).await?;
    serde_json::from_slice(&data)
        .map(Some)
        .map_err(io::Error::other)
}
pub async fn write_frame(writer: &mut (impl AsyncWrite + Unpin), data: &[u8]) -> io::Result<()> {
    if data.is_empty() || data.len() > MAX_FRAME {
        return Err(io::Error::other("Invalid adapter frame length"));
    }
    writer.write_u32(data.len() as u32).await?;
    writer.write_all(data).await?;
    writer.flush().await
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServiceDescriptor {
    pub id: String,
    pub version: u32,
    pub methods: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Initialized {
    pub protocol: u8,
    pub services: Vec<ServiceDescriptor>,
}
/// Validate a protocol identifier shared by service and package contracts.
pub fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value.split('.').all(|part| {
            part.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
}
pub fn validate(info: &Initialized) -> bool {
    let mut ids = std::collections::HashSet::new();
    let mut methods = std::collections::HashSet::new();
    info.protocol == 1
        && info.services.iter().all(|service| {
            name(&service.id)
                && service.id != "system"
                && !service.id.starts_with("system.")
                && service.version > 0
                && ids.insert(&service.id)
                && !service.methods.is_empty()
                && service.methods.iter().all(|method| {
                    name(method)
                        && method.starts_with(&format!("{}.", service.id))
                        && methods.insert(method)
                })
        })
}
