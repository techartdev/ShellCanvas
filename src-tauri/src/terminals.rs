// SPDX-License-Identifier: MPL-2.0
//! Connection-neutral console pump. No SSH channel types or assumptions.
use anyhow::{bail, Context, Result};
use shellcanvas_services::{
    TerminalEvent, TerminalInput, TerminalSize, TerminalStream, TERMINAL_CHUNK,
};
use std::{
    future::Future,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, Notify},
    time::timeout,
};

/// Exactly one unacknowledged output chunk. Input and teardown never wait on this gate.
#[derive(Default)]
pub struct OutputGate {
    sequence: AtomicU64,
    pending: AtomicU64,
    consumed: Notify,
}
impl OutputGate {
    pub fn begin(&self) -> u64 {
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst) + 1;
        self.pending.store(sequence, Ordering::SeqCst);
        sequence
    }
    pub fn acknowledge(&self, sequence: u64) -> Result<(), String> {
        if sequence == 0
            || self
                .pending
                .compare_exchange(sequence, 0, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
        {
            return Err("Output acknowledgement is stale or out of order".into());
        }
        self.consumed.notify_one();
        Ok(())
    }
    pub async fn wait(&self) {
        while self.pending.load(Ordering::SeqCst) != 0 {
            self.consumed.notified().await;
        }
    }
}

pub async fn run_terminal<F: Future<Output = bool>>(
    mut stream: TerminalStream,
    mut input: mpsc::Receiver<TerminalInput>,
    canceled: oneshot::Receiver<()>,
    output: impl Fn(TerminalEvent) -> F,
) {
    let result: Result<()> = {
        let write = async {
            while let Some(message) = input.recv().await {
                timeout(Duration::from_secs(15), async {
                    match message {
                        TerminalInput::Data(bytes) => {
                            if bytes.len() > TERMINAL_CHUNK {
                                bail!("Terminal input chunk exceeds 64 KiB");
                            }
                            stream.writer.write(&bytes).await
                        }
                        TerminalInput::Resize(cols, rows) if stream.resizable => {
                            stream.writer.resize(TerminalSize::new(cols, rows)).await
                        }
                        TerminalInput::Resize(_, _) => Ok(()),
                    }
                })
                .await
                .context("Terminal input timed out")??;
                tokio::task::yield_now().await;
            }
            Ok(())
        };
        let read = async {
            while let Some(bytes) = stream.reader.read().await? {
                if bytes.is_empty() || bytes.len() > TERMINAL_CHUNK {
                    bail!("Console returned an invalid output chunk");
                }
                if !output(TerminalEvent::Output(bytes)).await {
                    break;
                }
                tokio::task::yield_now().await;
            }
            Ok(())
        };
        tokio::select! {
            biased;
            _ = canceled => Ok(()),
            result = read => result,
            result = write => result,
        }
    };
    if let Err(error) = result {
        output(TerminalEvent::Error(format!("{error:#}"))).await;
    }
    // Both I/O futures are dropped before cleanup. A blocked write must not
    // prevent closing this window, even when another IPC caller holds a sender.
    let _ = timeout(Duration::from_secs(3), stream.writer.close()).await;
    output(TerminalEvent::Closed).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use shellcanvas_services::{TerminalReader, TerminalWriter};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };
    use tokio::sync::Notify;

    #[derive(Clone, Default)]
    struct Record {
        writes: Arc<Mutex<Vec<Vec<u8>>>>,
        sizes: Arc<Mutex<Vec<TerminalSize>>>,
        closes: Arc<AtomicUsize>,
        events: Arc<Mutex<Vec<TerminalEvent>>>,
    }
    struct Reader(mpsc::Receiver<Result<Vec<u8>>>);
    #[async_trait]
    impl TerminalReader for Reader {
        async fn read(&mut self) -> Result<Option<Vec<u8>>> {
            self.0.recv().await.transpose()
        }
    }
    struct Writer {
        record: Record,
        blocked: Option<Arc<Notify>>,
        fail: bool,
    }
    #[async_trait]
    impl TerminalWriter for Writer {
        async fn write(&mut self, bytes: &[u8]) -> Result<()> {
            if let Some(started) = &self.blocked {
                started.notify_one();
                std::future::pending::<()>().await;
            }
            if self.fail {
                bail!("Fixture input rejected");
            }
            self.record.writes.lock().unwrap().push(bytes.to_vec());
            Ok(())
        }
        async fn resize(&mut self, size: TerminalSize) -> Result<()> {
            self.record.sizes.lock().unwrap().push(size);
            Ok(())
        }
        async fn close(&mut self) -> Result<()> {
            self.record.closes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }
    struct Fixture {
        record: Record,
        remote: mpsc::Sender<Result<Vec<u8>>>,
        input: mpsc::Sender<TerminalInput>,
        cancel: oneshot::Sender<()>,
        task: tokio::task::JoinHandle<()>,
    }
    fn fixture(resizable: bool, blocked: Option<Arc<Notify>>, fail: bool) -> Fixture {
        let record = Record::default();
        let (remote, read) = mpsc::channel(8);
        let (input, recv) = mpsc::channel(8);
        let (cancel, canceled) = oneshot::channel();
        let stream = TerminalStream {
            reader: Box::new(Reader(read)),
            writer: Box::new(Writer {
                record: record.clone(),
                blocked,
                fail,
            }),
            resizable,
        };
        let events = record.events.clone();
        let task = tokio::spawn(run_terminal(stream, recv, canceled, move |event| {
            events.lock().unwrap().push(event);
            std::future::ready(true)
        }));
        Fixture {
            record,
            remote,
            input,
            cancel,
            task,
        }
    }
    async fn until(mut condition: impl FnMut() -> bool) {
        timeout(Duration::from_secs(2), async {
            while !condition() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    async fn finished(task: tokio::task::JoinHandle<()>) {
        timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn paused_output_preserves_bytes_and_does_not_block_input_or_close() {
        let record = Record::default();
        let (remote, read) = mpsc::channel(8);
        let (input, recv) = mpsc::channel(8);
        let (cancel, canceled) = oneshot::channel();
        let stream = TerminalStream {
            reader: Box::new(Reader(read)),
            writer: Box::new(Writer {
                record: record.clone(),
                blocked: None,
                fail: false,
            }),
            resizable: true,
        };
        let gate = Arc::new(OutputGate::default());
        let output_gate = gate.clone();
        let events = record.events.clone();
        let task = tokio::spawn(run_terminal(stream, recv, canceled, move |event| {
            let gate = output_gate.clone();
            let events = events.clone();
            async move {
                let is_output = matches!(&event, TerminalEvent::Output(_));
                if is_output {
                    gate.begin();
                }
                events.lock().unwrap().push(event);
                if is_output {
                    gate.wait().await;
                }
                true
            }
        }));
        remote.send(Ok(vec![0, 255, 0xf0])).await.unwrap();
        remote.send(Ok(vec![0x9f, 0x8c, 0x8a])).await.unwrap();
        until(|| record.events.lock().unwrap().len() == 1).await;
        input.send(TerminalInput::Data(vec![255, 0])).await.unwrap();
        until(|| !record.writes.lock().unwrap().is_empty()).await;
        assert_eq!(record.events.lock().unwrap().len(), 1);
        assert!(gate.acknowledge(2).is_err());
        gate.acknowledge(1).unwrap();
        until(|| record.events.lock().unwrap().len() == 2).await;
        assert!(gate.acknowledge(1).is_err());
        drop(cancel);
        finished(task).await;
        assert_eq!(
            *record.events.lock().unwrap(),
            vec![
                TerminalEvent::Output(vec![0, 255, 0xf0]),
                TerminalEvent::Output(vec![0x9f, 0x8c, 0x8a]),
                TerminalEvent::Closed
            ]
        );
        assert_eq!(record.closes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn blocked_input_does_not_block_output_or_explicit_close() {
        let started = Arc::new(Notify::new());
        let f = fixture(true, Some(started.clone()), false);
        f.input.send(TerminalInput::Data(vec![1])).await.unwrap();
        timeout(Duration::from_secs(2), started.notified())
            .await
            .unwrap();
        f.remote.send(Ok(vec![0xf0, 0x9f])).await.unwrap();
        f.remote.send(Ok(vec![0x8c, 0x8a])).await.unwrap();
        until(|| f.record.events.lock().unwrap().len() == 2).await;
        // Keep the sender alive: cancellation cannot depend on all clones dropping.
        drop(f.cancel);
        finished(f.task).await;
        assert_eq!(
            *f.record.events.lock().unwrap(),
            vec![
                TerminalEvent::Output(vec![0xf0, 0x9f]),
                TerminalEvent::Output(vec![0x8c, 0x8a]),
                TerminalEvent::Closed
            ]
        );
        assert_eq!(f.record.closes.load(Ordering::SeqCst), 1);
        assert!(f.input.is_closed());
        assert!(f.record.writes.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn independent_consoles_preserve_bytes_and_optional_resize() {
        let a = fixture(true, None, false);
        let b = fixture(false, None, false);
        a.input
            .send(TerminalInput::Resize(0, u32::MAX))
            .await
            .unwrap();
        a.input
            .send(TerminalInput::Data(vec![0, 0xff, 10]))
            .await
            .unwrap();
        b.input.send(TerminalInput::Resize(100, 40)).await.unwrap();
        b.input.send(TerminalInput::Data(vec![42])).await.unwrap();
        until(|| {
            !a.record.writes.lock().unwrap().is_empty()
                && !b.record.writes.lock().unwrap().is_empty()
        })
        .await;
        assert_eq!(
            *a.record.sizes.lock().unwrap(),
            vec![TerminalSize::new(2, 300)]
        );
        assert!(b.record.sizes.lock().unwrap().is_empty());
        assert_eq!(*a.record.writes.lock().unwrap(), vec![vec![0, 0xff, 10]]);
        drop(a.cancel);
        finished(a.task).await;
        assert_eq!(b.record.closes.load(Ordering::SeqCst), 0);
        b.input.send(TerminalInput::Data(vec![43])).await.unwrap();
        until(|| b.record.writes.lock().unwrap().len() == 2).await;
        drop(b.remote);
        finished(b.task).await;
        assert_eq!(*b.record.writes.lock().unwrap(), vec![vec![42], vec![43]]);
        assert_eq!(b.record.closes.load(Ordering::SeqCst), 1);
    }
    #[tokio::test]
    async fn invalid_input_and_provider_errors_close_once_without_retry() {
        for mode in 0..4 {
            let f = fixture(true, None, mode == 1);
            match mode {
                0 => f
                    .input
                    .send(TerminalInput::Data(vec![0; TERMINAL_CHUNK + 1]))
                    .await
                    .unwrap(),
                1 => f.input.send(TerminalInput::Data(vec![1])).await.unwrap(),
                2 => f
                    .remote
                    .send(Err(anyhow::anyhow!("Fixture read failed")))
                    .await
                    .unwrap(),
                _ => f
                    .remote
                    .send(Ok(vec![0; TERMINAL_CHUNK + 1]))
                    .await
                    .unwrap(),
            }
            finished(f.task).await;
            let events = f.record.events.lock().unwrap();
            assert_eq!(events.len(), 2);
            assert!(matches!(events[0], TerminalEvent::Error(_)));
            assert_eq!(events[1], TerminalEvent::Closed);
            assert_eq!(f.record.closes.load(Ordering::SeqCst), 1);
            assert!(f.record.writes.lock().unwrap().is_empty());
        }
    }
}
