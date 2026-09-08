// SPDX-License-Identifier: MPL-2.0
use crate::{FileLocation, FileTransferService, TRANSFER_CHUNK};
use anyhow::{bail, Result};
use std::sync::Arc;

pub struct CopyProgress {
    pub bytes: u64,
    pub total: u64,
    pub finishing: bool,
}

/// Copy one regular file within an explicit file service, without constructing
/// paths or publishing until the source has passed its final revision check.
/// Memory is bounded to one transfer chunk. Cancellation is cooperative between
/// provider operations; a successful publication is always reported as success.
pub async fn copy_regular_file(
    service: Arc<dyn FileTransferService>,
    path: &str,
    revision: &str,
    parent: &str,
    name: &str,
    canceled: impl Fn() -> bool + Send,
    progress: &mut (dyn FnMut(CopyProgress) + Send),
) -> Result<FileLocation> {
    let checkpoint = || -> Result<()> {
        if canceled() {
            bail!("Transfer canceled");
        }
        Ok(())
    };
    checkpoint()?;
    let mut reader = service.clone().download(path, revision).await?;
    let total = reader.file().size;
    let writer = async {
        checkpoint()?;
        service.upload(parent, name, total).await
    }
    .await;
    let mut writer = match writer {
        Ok(writer) => writer,
        Err(error) => return Err(with_cleanup(error, reader.abort().await)),
    };
    let result = async {
        let mut bytes = 0u64;
        progress(CopyProgress {
            bytes,
            total,
            finishing: false,
        });
        loop {
            checkpoint()?;
            let chunk = reader.read().await?;
            if chunk.is_empty() {
                break;
            }
            if chunk.len() > TRANSFER_CHUNK || chunk.len() as u64 > total.saturating_sub(bytes) {
                bail!("Source size changed or the provider exceeded the transfer chunk limit");
            }
            checkpoint()?;
            writer.write(&chunk).await?;
            bytes += chunk.len() as u64;
            progress(CopyProgress {
                bytes,
                total,
                finishing: false,
            });
        }
        if bytes != total {
            bail!("Source size changed during copy");
        }
        reader.finish().await?;
        checkpoint()?;
        progress(CopyProgress {
            bytes,
            total,
            finishing: true,
        });
        // Do not interrupt or reinterpret a completed no-clobber publication.
        writer.finish().await
    }
    .await;
    match result {
        Ok(location) => Ok(location),
        Err(error) => {
            let error = with_cleanup(error, reader.abort().await);
            Err(with_cleanup(error, writer.abort().await))
        }
    }
}
fn with_cleanup(error: anyhow::Error, cleanup: Result<()>) -> anyhow::Error {
    match cleanup {
        Ok(()) => error,
        Err(cleanup) => anyhow::anyhow!("{error:#}; cleanup failed: {cleanup:#}"),
    }
}
