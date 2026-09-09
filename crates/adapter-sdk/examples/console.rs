// SPDX-License-Identifier: MPL-2.0
// Byte loopback console: no shell command is executed. Sessions own separate queues.
use shellcanvas_adapter_sdk::{
    async_trait, json, run, Adapter, CallError, RequestContext, ServiceDescriptor, Value,
};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::watch;

const CHUNK: usize = 65_536;
const BUFFER: usize = 4 * CHUNK;
#[derive(Default)]
struct Sessions {
    live: HashMap<String, Arc<Session>>,
    retired: HashSet<String>,
}
struct Session {
    bytes: Mutex<VecDeque<u8>>,
    changed: watch::Sender<u64>,
}
#[derive(Default)]
struct Device(Mutex<Sessions>);
fn error(code: &str, message: &str) -> CallError {
    CallError::new(code, message)
}
fn id(params: &Value) -> Result<&str, CallError> {
    params["id"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 200)
        .ok_or_else(|| error("invalid", "Missing console identity"))
}
fn dimensions(params: &Value) -> Result<(), CallError> {
    if !params["cols"]
        .as_u64()
        .is_some_and(|n| (2..=500).contains(&n))
        || !params["rows"]
            .as_u64()
            .is_some_and(|n| (2..=300).contains(&n))
    {
        return Err(error("invalid", "Invalid console dimensions"));
    }
    Ok(())
}
impl Device {
    fn session(&self, id: &str) -> Result<Arc<Session>, CallError> {
        self.0
            .lock()
            .unwrap()
            .live
            .get(id)
            .cloned()
            .ok_or_else(|| error("closed", "Console is closed"))
    }
}
#[async_trait]
impl Adapter for Device {
    async fn initialize(
        &self,
        _: Value,
        _: RequestContext,
    ) -> Result<Vec<ServiceDescriptor>, CallError> {
        Ok(vec![ServiceDescriptor {
            id: "console".into(),
            version: 1,
            methods: [
                "console.open",
                "console.read",
                "console.write",
                "console.close",
            ]
            .map(String::from)
            .into(),
        }])
    }
    async fn call(
        &self,
        method: &str,
        params: Value,
        context: RequestContext,
    ) -> Result<Value, CallError> {
        let id = id(&params)?;
        // Cleanup must run even when its request is canceled.
        if method == "console.close" {
            let mut sessions = self.0.lock().unwrap();
            sessions.retired.insert(id.into());
            if let Some(session) = sessions.live.remove(id) {
                session.bytes.lock().unwrap().clear();
                session.changed.send_modify(|n| *n = n.wrapping_add(1));
            }
            return Ok(Value::Null);
        }
        if context.is_canceled() {
            return Err(error("aborted", "Console request canceled"));
        }
        match method {
            "console.open" => {
                dimensions(&params)?;
                // Reserve/check under one lock. A device with asynchronous setup must
                // recheck retirement after setup and release any unpublished resource.
                let mut sessions = self.0.lock().unwrap();
                if sessions.retired.contains(id) {
                    return Err(error("closed", "Console identity retired"));
                }
                if sessions.live.contains_key(id) {
                    return Err(error("invalid", "Console already open"));
                }
                if sessions.live.len() >= 32 {
                    return Err(error("busy", "Too many active consoles"));
                }
                let (changed, _) = watch::channel(0);
                sessions.live.insert(
                    id.into(),
                    Arc::new(Session {
                        bytes: Mutex::new(VecDeque::new()),
                        changed,
                    }),
                );
                Ok(json!({"resizable":false}))
            }
            "console.write" => {
                let bytes = params["bytes"]
                    .as_array()
                    .filter(|v| v.len() <= CHUNK)
                    .ok_or_else(|| error("invalid", "Invalid console byte chunk"))?;
                let bytes: Vec<u8> = bytes
                    .iter()
                    .map(|b| {
                        b.as_u64()
                            .filter(|n| *n <= 255)
                            .map(|n| n as u8)
                            .ok_or_else(|| error("invalid", "Invalid console byte"))
                    })
                    .collect::<Result<_, _>>()?;
                // Lock ordering is always registry then queue, also for close and read.
                let sessions = self.0.lock().unwrap();
                let session = sessions
                    .live
                    .get(id)
                    .ok_or_else(|| error("closed", "Console is closed"))?;
                let mut queue = session.bytes.lock().unwrap();
                if queue.len() + bytes.len() > BUFFER {
                    return Err(error("busy", "Read pending output before writing more"));
                }
                queue.extend(bytes);
                session.changed.send_modify(|n| *n = n.wrapping_add(1));
                Ok(Value::Null)
            }
            "console.read" => {
                let max = params["maxBytes"]
                    .as_u64()
                    .filter(|n| (1..=CHUNK as u64).contains(n))
                    .ok_or_else(|| error("invalid", "Invalid read size"))?
                    as usize;
                let wait = params["waitMs"]
                    .as_u64()
                    .filter(|n| *n <= 1000)
                    .ok_or_else(|| error("invalid", "Invalid read timeout"))?;
                let session = match self.session(id) {
                    Ok(session) => session,
                    Err(_) => return Ok(json!({"bytes":[],"closed":true})),
                };
                // Subscribe before examining the queue, so writes cannot lose a wakeup.
                let mut changed = session.changed.subscribe();
                let deadline = tokio::time::Instant::now() + Duration::from_millis(wait);
                loop {
                    if context.is_canceled() {
                        return Err(error("aborted", "Console read canceled"));
                    }
                    {
                        let sessions = self.0.lock().unwrap();
                        if !sessions.live.contains_key(id) {
                            return Ok(json!({"bytes":[],"closed":true}));
                        }
                        let mut queue = session.bytes.lock().unwrap();
                        if !queue.is_empty() {
                            let count = queue.len().min(max);
                            let bytes: Vec<_> = queue.drain(..count).collect();
                            return Ok(json!({"bytes":bytes,"closed":false}));
                        }
                    }
                    tokio::select! {
                        _ = context.canceled() => return Err(error("aborted", "Console read canceled")),
                        _ = tokio::time::sleep_until(deadline) => return Ok(json!({"bytes":[],"closed":false})),
                        _ = changed.changed() => {},
                    }
                }
            }
            _ => Err(error("unavailable", "Unsupported console operation")),
        }
    }
}
fn main() -> std::io::Result<()> {
    run(Device::default())
}
