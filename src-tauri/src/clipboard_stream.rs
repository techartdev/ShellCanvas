// SPDX-License-Identifier: MPL-2.0
//! Read-only, bounded-memory stream over the existing transfer contract.
use anyhow::{bail, Context, Result};
use shellcanvas_core::{FileEntry, FileTransferService, TransferReader, TRANSFER_CHUNK};
use std::{collections::VecDeque, sync::Arc, time::Duration};

#[derive(Clone)]
pub struct Source {
    pub entry: FileEntry,
    pub display_path: String,
    pub service: Arc<dyn FileTransferService>,
    pub runtime: tokio::runtime::Handle,
}
pub struct RemoteStream {
    pub source: Source,
    pub position: u64,
    read_position: u64,
    fetched: u64,
    reader: Option<Box<dyn TransferReader>>,
    pending: VecDeque<u8>,
    verified: bool,
    failed: bool,
}
impl RemoteStream {
    pub fn new(source: Source) -> Self {
        Self {
            source,
            position: 0,
            read_position: 0,
            fetched: 0,
            reader: None,
            pending: VecDeque::new(),
            verified: false,
            failed: false,
        }
    }
    fn abort(&mut self) {
        if let Some(mut reader) = self.reader.take() {
            self.source.runtime.spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(3), reader.abort()).await;
            });
        }
    }
    fn open(&mut self) -> Result<()> {
        if self.reader.is_none() && !self.verified {
            let source = &self.source;
            let reader = source.runtime.block_on(async {
                tokio::time::timeout(
                    Duration::from_secs(30),
                    source
                        .service
                        .clone()
                        .download(&source.entry.path, &source.entry.revision),
                )
                .await
                .context("Opening copied file timed out")?
            })?;
            let size = reader.file().size;
            self.reader = Some(reader);
            if size != source.entry.size {
                bail!("Copied file size changed. Copy it again.");
            }
        }
        Ok(())
    }
    fn fill(&mut self) -> Result<()> {
        if self.verified {
            return Ok(());
        }
        self.open()?;
        let reader = self.reader.as_mut().context("Copied stream is closed")?;
        let bytes = self.source.runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(30), reader.read())
                .await
                .context("Reading copied file timed out")?
        })?;
        if bytes.len() > TRANSFER_CHUNK
            || self.fetched + bytes.len() as u64 > self.source.entry.size
        {
            bail!("Invalid copied file size");
        }
        self.fetched += bytes.len() as u64;
        if bytes.is_empty() && self.fetched != self.source.entry.size {
            bail!("Copied file ended early");
        }
        self.pending.extend(bytes);
        // Verify before returning the final bytes, so Explorer cannot accept a
        // complete-sized file without the provider's end-of-transfer check.
        if self.fetched == self.source.entry.size {
            self.source.runtime.block_on(async {
                tokio::time::timeout(Duration::from_secs(30), reader.finish())
                    .await
                    .context("Verifying copied file timed out")?
            })?;
            self.verified = true;
            self.reader = None;
        }
        Ok(())
    }
    fn consume(&mut self, output: &mut [u8]) -> Result<usize> {
        let mut count = 0;
        while count < output.len() {
            if self.pending.is_empty() {
                self.fill()?;
            }
            if self.pending.is_empty() {
                break;
            }
            while count < output.len() {
                let Some(byte) = self.pending.pop_front() else {
                    break;
                };
                output[count] = byte;
                count += 1;
                self.read_position += 1;
            }
        }
        Ok(count)
    }
    pub fn read(&mut self, output: &mut [u8]) -> Result<usize> {
        if self.failed {
            bail!("Copied stream failed. Copy the file again.");
        }
        let result = self.read_inner(output);
        if result.is_err() {
            self.failed = true;
            self.abort();
        }
        result
    }
    fn read_inner(&mut self, output: &mut [u8]) -> Result<usize> {
        if self.position < self.read_position {
            self.abort();
            self.pending.clear();
            self.fetched = 0;
            self.read_position = 0;
            self.verified = false;
        }
        let mut discard = [0u8; TRANSFER_CHUNK];
        while self.read_position < self.position {
            let len = (self.position - self.read_position).min(TRANSFER_CHUNK as u64) as usize;
            if self.consume(&mut discard[..len])? == 0 {
                break;
            }
        }
        let count = self.consume(output)?;
        self.position += count as u64;
        Ok(count)
    }
    pub fn seek(&mut self, offset: i64, origin: u32) -> Result<u64> {
        let base = match origin {
            0 => 0,
            1 => self.position,
            2 => self.source.entry.size,
            _ => bail!("Invalid seek origin"),
        };
        let position = base as i128 + offset as i128;
        if position < 0 || position > self.source.entry.size as i128 {
            bail!("Seek outside copied file");
        }
        self.position = position as u64;
        Ok(self.position)
    }
}
impl Drop for RemoteStream {
    fn drop(&mut self) {
        self.abort();
    }
}
