// SPDX-License-Identifier: MPL-2.0
//! Observe the lifetime of one SFTP stream without sending probe traffic.
use std::{
    io,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

pub(crate) struct Observed<S> {
    inner: S,
    closed: Arc<AtomicBool>,
}
impl<S> Observed<S> {
    pub(crate) fn new(inner: S, closed: Arc<AtomicBool>) -> Self {
        Self { inner, closed }
    }
}
impl<S> Drop for Observed<S> {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
    }
}
impl<S: AsyncRead + Unpin> AsyncRead for Observed<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let had_space = buf.remaining() != 0;
        let result = Pin::new(&mut self.inner).poll_read(cx, buf);
        if matches!(&result, Poll::Ready(Err(_)))
            || (matches!(&result, Poll::Ready(Ok(()))) && had_space && buf.filled().len() == before)
        {
            self.closed.store(true, Ordering::Release);
        }
        result
    }
}
impl<S: AsyncWrite + Unpin> AsyncWrite for Observed<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let result = Pin::new(&mut self.inner).poll_write(cx, bytes);
        if matches!(&result, Poll::Ready(Err(_)))
            || (!bytes.is_empty() && matches!(&result, Poll::Ready(Ok(0))))
        {
            self.closed.store(true, Ordering::Release);
        }
        result
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let result = Pin::new(&mut self.inner).poll_flush(cx);
        if matches!(&result, Poll::Ready(Err(_))) {
            self.closed.store(true, Ordering::Release);
        }
        result
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let result = Pin::new(&mut self.inner).poll_shutdown(cx);
        if result.is_ready() {
            self.closed.store(true, Ordering::Release);
        }
        result
    }
}
