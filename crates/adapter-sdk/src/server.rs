// SPDX-License-Identifier: MPL-2.0
use crate::{
    async_trait,
    wire::{self, Envelope, Initialized, ServiceDescriptor},
    Value,
};
use std::{collections::HashMap, io, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{mpsc, watch},
    task::JoinSet,
};

const MAX_CALLS: usize = 32;
const MAX_ID: u64 = 9_007_199_254_740_991;

/// A public error message must not contain credentials or raw device responses.
#[derive(Debug, Clone)]
pub struct CallError {
    pub code: String,
    pub message: String,
}
impl CallError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// Cancellation requests a stop; it cannot undo an already dispatched write.
#[derive(Clone)]
pub struct RequestContext {
    pub id: u64,
    canceled: watch::Receiver<bool>,
}
impl RequestContext {
    pub fn is_canceled(&self) -> bool {
        *self.canceled.borrow() || self.canceled.has_changed().is_err()
    }
    pub async fn canceled(&self) {
        let mut canceled = self.canceled.clone();
        if !*canceled.borrow() {
            let _ = canceled.changed().await;
        }
    }
}

#[async_trait]
pub trait Adapter: Send + Sync + 'static {
    /// Open the connection and return supported operations, immutable until exit.
    async fn initialize(
        &self,
        configuration: Value,
        context: RequestContext,
    ) -> Result<Vec<ServiceDescriptor>, CallError>;
    /// Calls run concurrently. Protect shared device state, observe cancellation,
    /// finish cleanup, and return the authoritative outcome.
    async fn call(
        &self,
        method: &str,
        params: Value,
        context: RequestContext,
    ) -> Result<Value, CallError>;
}

pub fn run(adapter: impl Adapter) -> io::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(serve(adapter, tokio::io::stdin(), tokio::io::stdout()));
    // Tokio stdin uses a blocking read which cannot be aborted. Do not let
    // runtime destruction wait forever after a protocol error with an open pipe.
    runtime.shutdown_timeout(Duration::from_millis(100));
    result
}

fn failed(id: u64, error: CallError) -> Envelope {
    let valid = matches!(
        error.code.as_str(),
        "invalid"
            | "closed"
            | "aborted"
            | "denied"
            | "unavailable"
            | "busy"
            | "failed"
            | "deadline"
    ) && error.message.len() <= 4096;
    Envelope::Error {
        v: 1,
        id,
        code: if valid { error.code } else { "failed".into() },
        message: if valid {
            error.message
        } else {
            "Adapter returned an invalid error".into()
        },
    }
}
fn invalid(message: &str) -> io::Error {
    io::Error::other(message)
}

/// Serve one framed connection. Queues and concurrency are bounded; total
/// requests/bytes are not capped. Disconnect allows five seconds for cleanup.
/// Adapter resources also need RAII cleanup for forced process termination.
pub async fn serve(
    adapter: impl Adapter,
    mut input: impl AsyncRead + Unpin + Send + 'static,
    mut output: impl AsyncWrite + Unpin + Send + 'static,
) -> io::Result<()> {
    let adapter = Arc::new(adapter);
    let (incoming, mut receive) = mpsc::channel(4);
    let (send, mut outgoing) = mpsc::channel::<Vec<u8>>(MAX_CALLS * 2);
    // Never cancel a partially read frame when another request completes.
    // JoinSet aborts both pipe tasks if the serve future itself is dropped.
    let mut pipes = JoinSet::new();
    pipes.spawn(async move {
        loop {
            let frame = wire::read_frame_or_eof(&mut input).await;
            let ended = !matches!(frame, Ok(Some(_)));
            if incoming.send(frame).await.is_err() || ended {
                break;
            }
        }
        std::future::pending::<io::Result<()>>().await
    });
    pipes.spawn(async move {
        while let Some(bytes) = outgoing.recv().await {
            tokio::time::timeout(
                Duration::from_secs(10),
                wire::write_frame(&mut output, &bytes),
            )
            .await
            .map_err(|_| invalid("Adapter output pipe stalled"))??;
        }
        Ok(())
    });
    let mut calls = JoinSet::new();
    let mut cancellation: HashMap<u64, watch::Sender<bool>> = HashMap::new();
    let mut last_id = 0;
    let mut catalog: Option<Vec<ServiceDescriptor>> = None;
    let result = loop {
        tokio::select! {
            ended = pipes.join_next() => {
                break match ended {
                    Some(Ok(result)) => result,
                    _ => Err(invalid("Adapter protocol pipe failed")),
                };
            }
            completed = calls.join_next(), if !calls.is_empty() => {
                let Some(Ok((id, reply, initialized))) = completed else {
                    break Err(invalid("Adapter request task failed"));
                };
                cancellation.remove(&id);
                if let Some(services) = initialized { catalog = Some(services); }
                let bytes = match wire::encode(&reply) {
                    Ok(bytes) => bytes,
                    Err(error) => break Err(error),
                };
                if send.try_send(bytes).is_err() {
                    break Err(invalid("Adapter output queue is full or closed"));
                }
            }
            message = receive.recv() => {
                let message = match message {
                    Some(Ok(Some(message))) => message,
                    Some(Ok(None)) => break Ok(()),
                    Some(Err(error)) => break Err(error),
                    None => break Err(invalid("Adapter input stopped")),
                };
                let (id, method, params) = match message {
                    Envelope::Cancel {v: 1, id} if id > 0 && id <= last_id => {
                        if let Some(cancel) = cancellation.get(&id) { cancel.send_replace(true); }
                        continue;
                    }
                    Envelope::Request {v: 1, id, method, params} if id > last_id && id <= MAX_ID => (id, method, params),
                    _ => break Err(invalid("Invalid adapter request envelope or request identity")),
                };
                let initialize = last_id == 0 && method == "system.adapter.initialize";
                last_id = id;
                if !initialize && catalog.is_none() {
                    break Err(invalid("Initialize the adapter before sending service requests"));
                }
                let rejection = if calls.len() >= MAX_CALLS {
                    Some(CallError::new("busy", "Adapter has too many active requests"))
                } else if !initialize && !catalog.as_ref().unwrap().iter().any(|service| service.methods.contains(&method)) {
                    Some(CallError::new("unavailable", "The adapter does not advertise this method"))
                } else { None };
                if let Some(error) = rejection {
                    let bytes = match wire::encode(&failed(id, error)) {
                        Ok(bytes) => bytes,
                        Err(error) => break Err(error),
                    };
                    if send.try_send(bytes).is_err() { break Err(invalid("Adapter output queue is full or closed")); }
                    continue;
                }
                let (cancel, canceled) = watch::channel(false);
                cancellation.insert(id, cancel);
                let context = RequestContext {id, canceled};
                let adapter = adapter.clone();
                calls.spawn(async move {
                    let mut services = None;
                    let value = if initialize {
                        #[derive(serde::Deserialize)]
                        #[serde(deny_unknown_fields)]
                        struct Setup {protocol: u8, configuration: Value}
                        match serde_json::from_value::<Setup>(params) {
                            Ok(setup) if setup.protocol == 1 => match adapter.initialize(setup.configuration, context).await {
                                Ok(catalog) => {
                                    let initialized = Initialized {protocol: 1, services: catalog};
                                    if wire::validate(&initialized) {
                                        let value = serde_json::to_value(&initialized).expect("Protocol descriptor");
                                        services = Some(initialized.services);
                                        Ok(value)
                                    } else { Err(CallError::new("invalid", "Adapter advertised an invalid service catalog")) }
                                }
                                Err(error) => Err(error),
                            },
                            _ => Err(CallError::new("invalid", "Unsupported adapter initialization")),
                        }
                    } else { adapter.call(&method, params, context).await };
                    let reply = match value {
                        Ok(value) => Envelope::Result {v: 1, id, value},
                        Err(error) => failed(id, error),
                    };
                    (id, reply, services)
                });
            }
        }
    };
    for cancel in cancellation.values() {
        cancel.send_replace(true);
    }
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        while calls.join_next().await.is_some() {}
    })
    .await;
    result
}
