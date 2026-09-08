// SPDX-License-Identifier: MPL-2.0
use crate::{
    Connection, TerminalReader, TerminalService, TerminalSize, TerminalStream, TerminalWriter,
};
use anyhow::Result;
use async_trait::async_trait;
use russh::{client, ChannelMsg, ChannelReadHalf, ChannelWriteHalf};
use std::time::Duration;

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
