// SPDX-License-Identifier: MPL-2.0
//! Byte-oriented interactive consoles, independent of connection protocol.
use anyhow::Result;
use async_trait::async_trait;
use serde::Serialize;

pub const TERMINAL_CHUNK: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalSize {
    pub cols: u32,
    pub rows: u32,
}
impl TerminalSize {
    pub fn new(cols: u32, rows: u32) -> Self {
        Self {
            cols: cols.clamp(2, 500),
            rows: rows.clamp(2, 300),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output(Vec<u8>),
    Closed,
    Error(String),
}
pub enum TerminalInput {
    Data(Vec<u8>),
    Resize(u32, u32),
}

#[async_trait]
pub trait TerminalReader: Send {
    /// Return a nonempty chunk of at most TERMINAL_CHUNK bytes, or None at EOF.
    /// No text decoding: multibyte characters may cross chunk boundaries.
    async fn read(&mut self) -> Result<Option<Vec<u8>>>;
}
#[async_trait]
pub trait TerminalWriter: Send {
    /// May be canceled during teardown. Partial delivery must never be retried.
    async fn write(&mut self, bytes: &[u8]) -> Result<()>;
    async fn resize(&mut self, size: TerminalSize) -> Result<()>;
    /// Release this console, not another console sharing its connection.
    async fn close(&mut self) -> Result<()>;
}

/// Separate halves allow output to flow while input is backpressured.
/// Adapters own cleanup of dropped handles, including abandoned opens.
pub struct TerminalStream {
    pub reader: Box<dyn TerminalReader>,
    pub writer: Box<dyn TerminalWriter>,
    /// Fixed-size consoles may omit resize support without losing byte I/O.
    pub resizable: bool,
}
#[async_trait]
pub trait TerminalService: Send + Sync {
    /// Open one independently owned console, bounded by the caller's deadline.
    async fn open(&self, size: TerminalSize) -> Result<TerminalStream>;
}
