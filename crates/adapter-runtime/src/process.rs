// SPDX-License-Identifier: MPL-2.0
use crate::wire::{self, Envelope, Initialized, ServiceDescriptor};
use async_trait::async_trait;
use serde_json::{json, Value};
use shellcanvas_services::ConnectionLifecycle;
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    process::{Child, Command},
    sync::{mpsc, oneshot, watch, Notify, OwnedSemaphorePermit, Semaphore},
};

const MAX_CALLS: usize = 32;
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdapterError {
    pub code: String,
    pub message: String,
    /// Conservative: a dispatched operation may have had effects. Never auto-retry it.
    pub outcome_uncertain: bool,
}
impl std::fmt::Display for AdapterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for AdapterError {}
fn error(code: &str, message: &str, outcome_uncertain: bool) -> AdapterError {
    AdapterError {
        code: code.into(),
        message: message.into(),
        outcome_uncertain,
    }
}
/// Only construct after trusting the executable. No PATH lookup or shell expansion.
pub struct Launch {
    pub executable: PathBuf,
    pub arguments: Vec<String>,
    pub directory: PathBuf,
}
type Reply = oneshot::Sender<Result<Value, AdapterError>>;
struct Request {
    method: String,
    params: Value,
    reply: Reply,
    dispatched: Arc<AtomicBool>,
    permit: OwnedSemaphorePermit,
}
struct Pending {
    reply: Reply,
    _permit: OwnedSemaphorePermit,
}
struct Inner {
    requests: mpsc::Sender<Request>,
    stop: watch::Sender<bool>,
    done: watch::Receiver<Option<Result<(), AdapterError>>>,
    alive: Arc<AtomicBool>,
    wake: Arc<Notify>,
    slots: Arc<Semaphore>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        self.stop.send_replace(true);
    }
}
struct WakeOnDrop(Arc<Notify>);
impl Drop for WakeOnDrop {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}

#[derive(Clone)]
pub struct AdapterProcess {
    inner: Arc<Inner>,
    services: Arc<Vec<ServiceDescriptor>>,
}
impl AdapterProcess {
    pub async fn launch(
        launch: Launch,
        configuration: Value,
        deadline: Duration,
    ) -> Result<Self, AdapterError> {
        Self::launch_owned(launch, configuration, deadline, None).await
    }
    pub(crate) async fn launch_owned(
        launch: Launch,
        configuration: Value,
        deadline: Duration,
        owner: Option<Arc<dyn Send + Sync>>,
    ) -> Result<Self, AdapterError> {
        if !launch.executable.is_absolute() || !launch.directory.is_absolute() {
            return Err(error(
                "invalid",
                "Adapter executable and working directory must be absolute paths",
                false,
            ));
        }
        // Windows may route batch files through cmd.exe. Native adapters use an explicit
        // .exe (an interpreter is allowed, with its script supplied as a separate argument).
        #[cfg(windows)]
        if !launch
            .executable
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
        {
            return Err(error(
                "invalid",
                "Windows adapters must launch an explicit .exe, not a batch file or shortcut",
                false,
            ));
        }
        // Preflight before starting a native process. Configuration travels on stdin, not argv/logs.
        wire::encode(&Envelope::Request {
            v: 1,
            id: 1,
            method: "system.adapter.initialize".into(),
            params: json!({"protocol": 1, "configuration": configuration}),
        })
        .map_err(|_| {
            error(
                "invalid",
                "Adapter configuration exceeds the protocol envelope",
                false,
            )
        })?;
        let mut command = Command::new(&launch.executable);
        command
            .args(&launch.arguments)
            .current_dir(&launch.directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW; never open a console for a connector.
        let child = command.spawn().map_err(|_| {
            error(
                "failed",
                "Unable to start the trusted adapter executable",
                false,
            )
        })?;
        let (requests, receive) = mpsc::channel(MAX_CALLS);
        let (stop, stopping) = watch::channel(false);
        let (complete, done) = watch::channel(None);
        let alive = Arc::new(AtomicBool::new(true));
        let wake = Arc::new(Notify::new());
        tokio::spawn(run(
            child,
            receive,
            stopping,
            complete,
            alive.clone(),
            wake.clone(),
            owner,
        ));
        let mut process = Self {
            inner: Arc::new(Inner {
                requests,
                stop,
                done,
                alive,
                wake,
                slots: Arc::new(Semaphore::new(MAX_CALLS)),
            }),
            services: Arc::new(vec![]),
        };
        let initialized = process
            .request(
                "system.adapter.initialize",
                json!({"protocol":1, "configuration":configuration}),
                deadline,
            )
            .await;
        let info = initialized
            .and_then(|value| {
                serde_json::from_value::<Initialized>(value).map_err(|_| {
                    error(
                        "invalid",
                        "The adapter returned an invalid initialization response",
                        false,
                    )
                })
            })
            .and_then(|info| {
                if wire::validate(&info) {
                    Ok(info)
                } else {
                    Err(error(
                        "unavailable",
                        "Unsupported adapter protocol or invalid service catalog",
                        false,
                    ))
                }
            });
        match info {
            Ok(info) => {
                process.services = Arc::new(info.services);
                Ok(process)
            }
            Err(reason) => {
                let _ = process.close().await;
                Err(reason)
            }
        }
    }
    pub fn services(&self) -> &[ServiceDescriptor] {
        &self.services
    }
    pub fn supports(&self, service: &str, version: u32, methods: &[&str]) -> bool {
        self.services.iter().any(|item| {
            item.id == service
                && item.version == version
                && methods
                    .iter()
                    .all(|method| item.methods.iter().any(|name| name == method))
        })
    }
    pub fn connected(&self) -> bool {
        self.inner.alive.load(Ordering::Acquire)
    }
    /// Only advertised methods may be called. Drop the future to cancel; deadlines never retry.
    pub async fn call(
        &self,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<Value, AdapterError> {
        if !self
            .services
            .iter()
            .any(|service| service.methods.iter().any(|name| name == method))
        {
            return Err(error(
                "unavailable",
                "This adapter does not advertise the requested method",
                false,
            ));
        }
        self.request(method, params, deadline).await
    }
    async fn request(
        &self,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<Value, AdapterError> {
        if !self.connected() {
            return Err(error("closed", "The adapter connection is closed", false));
        }
        if deadline.is_zero() {
            return Err(error(
                "deadline",
                "Adapter operation deadline expired before dispatch",
                false,
            ));
        }
        let permit = self.inner.slots.clone().try_acquire_owned().map_err(|_| {
            error(
                "busy",
                "The adapter has too many concurrent operations; wait for active work",
                false,
            )
        })?;
        let (reply, result) = oneshot::channel();
        let dispatched = Arc::new(AtomicBool::new(false));
        let _cancellation = WakeOnDrop(self.inner.wake.clone());
        self.inner
            .requests
            .try_send(Request {
                method: method.into(),
                params,
                reply,
                dispatched: dispatched.clone(),
                permit,
            })
            .map_err(|_| error("closed", "The adapter connection is closed", false))?;
        match tokio::time::timeout(deadline, result).await {
            Ok(Ok(result)) => {
                if self.connected() {
                    result
                } else {
                    Err(error(
                        "closed",
                        "The adapter connection closed before the result was accepted",
                        dispatched.load(Ordering::Acquire),
                    ))
                }
            }
            Ok(Err(_)) => Err(error(
                "closed",
                "The adapter connection stopped responding",
                dispatched.load(Ordering::Acquire),
            )),
            Err(_) => Err(error(
                "deadline",
                "Adapter operation timed out; inspect any mutation before retrying",
                dispatched.load(Ordering::Acquire),
            )),
        }
    }
    /// Invalidates calls immediately. Worker cleanup survives cancellation of this waiter.
    pub async fn close(&self) -> Result<(), AdapterError> {
        self.inner.alive.store(false, Ordering::Release);
        self.inner.stop.send_replace(true);
        let mut done = self.inner.done.clone();
        loop {
            if let Some(result) = done.borrow_and_update().clone() {
                return result;
            }
            if done.changed().await.is_err() {
                return Err(error(
                    "closed",
                    "Adapter cleanup could not be confirmed",
                    true,
                ));
            }
        }
    }
}
#[async_trait]
impl ConnectionLifecycle for AdapterProcess {
    fn is_connected(&self) -> bool {
        self.connected()
    }
    async fn disconnect(&self) -> anyhow::Result<()> {
        self.close().await.map_err(Into::into)
    }
}

async fn run(
    mut child: Child,
    mut requests: mpsc::Receiver<Request>,
    mut stop: watch::Receiver<bool>,
    complete: watch::Sender<Option<Result<(), AdapterError>>>,
    alive: Arc<AtomicBool>,
    wake: Arc<Notify>,
    owner: Option<Arc<dyn Send + Sync>>,
) {
    let mut stdin = child.stdin.take().expect("piped stdin");
    let mut stdout = child.stdout.take().expect("piped stdout");
    let (outbound, mut outgoing) = mpsc::channel::<Vec<u8>>(MAX_CALLS * 2);
    let (incoming, mut responses) = mpsc::channel(4);
    let (broken, mut failure) = mpsc::channel(1);
    // Frame reads/writes run to completion. Canceling a select branch must not lose partial framing.
    let writer = tokio::spawn(async move {
        while let Some(data) = outgoing.recv().await {
            if !matches!(
                tokio::time::timeout(
                    Duration::from_secs(10),
                    wire::write_frame(&mut stdin, &data)
                )
                .await,
                Ok(Ok(()))
            ) {
                let _ = broken.send(()).await;
                break;
            }
        }
    });
    let reader = tokio::spawn(async move {
        loop {
            let message = wire::read_frame(&mut stdout).await;
            let failed = message.is_err();
            if incoming.send(message).await.is_err() || failed {
                break;
            }
        }
    });
    let mut pending: HashMap<u64, Pending> = HashMap::new();
    let mut next = 1u64;
    let mut sweep = tokio::time::interval(Duration::from_millis(100));
    sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let reason = loop {
        // Cancellation is per call. No tombstone growth: IDs are monotonic within this process.
        let canceled: Vec<_> = pending
            .iter()
            .filter(|(_, item)| item.reply.is_closed())
            .map(|(id, _)| *id)
            .collect();
        let mut saturated = false;
        for id in canceled {
            pending.remove(&id);
            let data =
                wire::encode(&Envelope::Cancel { v: 1, id }).expect("small cancellation frame");
            if outbound.try_send(data).is_err() {
                saturated = true;
                break;
            }
        }
        if saturated {
            break Some("Adapter input stopped accepting requests");
        }
        if *stop.borrow() {
            break None;
        }
        tokio::select! {
            biased;
            _ = stop.changed() => { break None; }
            _ = child.wait() => { break Some("The adapter process exited"); }
            _ = failure.recv() => { break Some("The adapter input pipe failed or stalled"); }
            _ = wake.notified() => {}
            _ = sweep.tick() => {}
            response = responses.recv() => {
                let Some(Ok(message)) = response else { break Some("The adapter output ended or violated the protocol"); };
                let (id, value) = match message {
                    Envelope::Result { v: 1, id, value } => (id, Ok(value)),
                    Envelope::Error { v: 1, id, code, message } if message.len() <= 4096 && ["invalid", "closed", "aborted", "denied", "unavailable", "busy", "failed", "deadline"].contains(&code.as_str()) => (id, Err(AdapterError { code, message, outcome_uncertain: true })),
                    _ => { break Some("The adapter sent an invalid response"); }
                };
                if id == 0 || id >= next { break Some("The adapter replied to an unknown request"); }
                if let Some(item) = pending.remove(&id) { let _ = item.reply.send(value); }
                // A completed/canceled request can have a late reply. It cannot reach another call.
            }
            request = requests.recv() => {
                let Some(request) = request else { break None; };
                if request.reply.is_closed() { continue; }
                if next >= 9_007_199_254_740_991 { break Some("Adapter request identity space exhausted"); }
                let data = match wire::encode(&Envelope::Request { v: 1, id: next, method: request.method, params: request.params }) {
                    Ok(data) => data,
                    Err(_) => { let _ = request.reply.send(Err(error("invalid", "Request exceeds the adapter frame limit; use a paged or streamed service", false))); continue; }
                };
                if outbound.try_send(data).is_err() { break Some("Adapter input stopped accepting requests"); }
                request.dispatched.store(true, Ordering::Release);
                pending.insert(next, Pending { reply: request.reply, _permit: request.permit });
                next += 1;
            }
        }
    };
    alive.store(false, Ordering::Release);
    requests.close();
    for (_, item) in pending {
        let _ = item.reply.send(Err(error(
            "closed",
            reason.unwrap_or("The adapter connection was closed"),
            true,
        )));
    }
    while let Ok(item) = requests.try_recv() {
        let _ = item.reply.send(Err(error(
            "closed",
            "The adapter connection was closed before dispatch",
            false,
        )));
    }
    reader.abort();
    writer.abort();
    let _ = tokio::join!(reader, writer);
    // Kill and reap the directly owned process. kill_on_drop is a fallback if the runtime stops.
    let cleanup = tokio::time::timeout(Duration::from_secs(2), child.kill()).await;
    let outcome = if matches!(cleanup, Ok(Ok(()))) || matches!(child.try_wait(), Ok(Some(_))) {
        Ok(())
    } else {
        Err(error(
            "closed",
            "Adapter process cleanup could not be confirmed",
            true,
        ))
    };
    if outcome.is_err() {
        if let Some(owner) = owner {
            std::mem::forget(owner);
        }
    } else {
        drop(owner);
    }
    complete.send_replace(Some(outcome));
}
