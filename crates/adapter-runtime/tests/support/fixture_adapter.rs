// SPDX-License-Identifier: MPL-2.0
//! Synthetic process fixture. Never connects to a real device or loads credentials.
use serde_json::{json, Value};
use shellcanvas_adapter_runtime::wire::{self, Envelope};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};
use tokio::{io::AsyncWriteExt, sync::mpsc};

#[tokio::main]
async fn main() {
    let mut stdin = tokio::io::stdin();
    let (send, mut receive) = mpsc::channel::<Vec<u8>>(4);
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(data) = receive.recv().await {
            // The malformed tests deliberately bypass write_frame's validation.
            stdout.write_u32(data.len() as u32).await.unwrap();
            stdout.write_all(&data).await.unwrap();
            stdout.flush().await.unwrap();
        }
    });
    let canceled = Arc::new(AtomicUsize::new(0));
    let calls = Arc::new(AtomicUsize::new(0));
    let waits = Arc::new(AtomicUsize::new(0));
    let state = Arc::new(Mutex::new(Device::default()));
    while let Ok(message) = wire::read_frame(&mut stdin).await {
        let (id, method, params) = match message {
            Envelope::Cancel { v: 1, .. } => {
                canceled.fetch_add(1, Ordering::SeqCst);
                continue;
            }
            Envelope::Request {
                v: 1,
                id,
                method,
                params,
            } => (id, method, params),
            _ => break,
        };
        let send = send.clone();
        let canceled = canceled.clone();
        let calls = calls.clone();
        let waits = waits.clone();
        let state = state.clone();
        if method == "acme.wait" {
            waits.fetch_add(1, Ordering::SeqCst);
        }
        calls.fetch_add(1, Ordering::SeqCst);
        tokio::spawn(async move {
            let value = match method.as_str() {
                "system.adapter.initialize" => {
                    let protocol = params["configuration"]["protocol"].as_u64().unwrap_or(1);
                    let mut services = json!([{"id":"acme", "version":1, "methods":["acme.echo","acme.wait","acme.fail","acme.crash","acme.malformed","acme.oversize","acme.unknown","acme.cancelCount","acme.calls","acme.waitCount","acme.consoleCount","acme.openCount","acme.arguments"]}]);
                    let config = params["configuration"].clone();
                    if config["standard"] == "files" || config["standard"] == "both" {
                        services.as_array_mut().unwrap().push(json!({"id":"files","version":1,"methods":["files.list","files.locate","files.preview"]}));
                    }
                    if config["standard"] == "console" || config["standard"] == "both" {
                        services.as_array_mut().unwrap().push(json!({"id":"console","version":1,"methods":["console.open","console.read","console.write","console.close","console.resize"]}));
                    }
                    state.lock().unwrap().config = config;
                    if params["configuration"]["duplicate"] == true {
                        let duplicate = services[0].clone();
                        services.as_array_mut().unwrap().push(duplicate);
                    }
                    if params["configuration"]["hang"] == true {
                        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    }
                    json!({"protocol":protocol,"services":services})
                }
                "acme.echo" => params,
                "acme.arguments" => json!(std::env::args().skip(1).collect::<Vec<_>>()),
                "acme.wait" => {
                    tokio::time::sleep(std::time::Duration::from_millis(
                        params["ms"].as_u64().unwrap_or(100),
                    ))
                    .await;
                    params["value"].clone()
                }
                "acme.cancelCount" => json!(canceled.load(Ordering::SeqCst)),
                "acme.calls" => json!(calls.load(Ordering::SeqCst)),
                "acme.waitCount" => json!(waits.load(Ordering::SeqCst)),
                "acme.fail" => {
                    let _ = send
                        .send(
                            wire::encode(&Envelope::Error {
                                v: 1,
                                id,
                                code: "denied".into(),
                                message: "Fixture refused the operation".into(),
                            })
                            .unwrap(),
                        )
                        .await;
                    return;
                }
                "acme.crash" => std::process::exit(7),
                "acme.malformed" => {
                    let _ = send.send(b"not-json".to_vec()).await;
                    return;
                }
                "acme.oversize" => {
                    let _ = send.send(vec![b' '; wire::MAX_FRAME + 1]).await;
                    return;
                }
                "acme.unknown" => {
                    let _ = send
                        .send(
                            wire::encode(&Envelope::Result {
                                v: 1,
                                id: 9_000_000,
                                value: Value::Null,
                            })
                            .unwrap(),
                        )
                        .await;
                    return;
                }
                _ => {
                    if method == "console.open" {
                        let delay = {
                            let mut state = state.lock().unwrap();
                            state.opens += 1;
                            state.config["openDelay"].as_u64().unwrap_or(0)
                        };
                        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                    }
                    match state.lock().unwrap().call(&method, &params) {
                        Ok(value) => value,
                        Err(message) => {
                            // Queue after dropping the guard below; this fixture only emits tiny errors.
                            let data = wire::encode(&Envelope::Error {
                                v: 1,
                                id,
                                code: "failed".into(),
                                message,
                            })
                            .unwrap();
                            let _ = send.try_send(data);
                            return;
                        }
                    }
                }
            };
            let _ = send
                .send(wire::encode(&Envelope::Result { v: 1, id, value }).unwrap())
                .await;
        });
    }
    drop(send);
    let _ = writer.await;
}

#[derive(Default)]
struct Device {
    config: Value,
    consoles: HashMap<String, VecDeque<u8>>,
    retired: HashSet<String>,
    opens: usize,
}
impl Device {
    fn call(&mut self, method: &str, params: &Value) -> Result<Value, String> {
        let id = params["id"].as_str().unwrap_or("");
        match method {
            "files.list" => {
                let total = self.config["entries"].as_u64().unwrap_or(350) as usize;
                let offset = params["cursor"]
                    .as_str()
                    .and_then(|v| v.strip_prefix("page:"))
                    .and_then(|v| v.parse::<usize>().ok())
                    .unwrap_or(0);
                let end = (offset + 128).min(total);
                let mut path = params["path"]
                    .as_str()
                    .unwrap_or("device://inventory?root=main");
                if offset > 0 && self.config["changedPage"] == true {
                    path = "another-location";
                }
                let entries: Vec<_> = (offset..end).map(|n| json!({"path":format!("opaque#{n}"),"name":format!("Item {n}"),"kind":"file","size":0,"modified":null,"revision":"1"})).collect();
                Ok(
                    json!({"directory":{"path":path,"name":"Device inventory","parent":null,"home":null,"roots":[],"entries":entries},"next":if end<total {Some(format!("page:{end}"))} else {None}}),
                )
            }
            "files.locate" => {
                Ok(json!({"path":params["path"],"name":"Selected item","parent":null}))
            }
            "files.preview" => Ok(json!("Synthetic adapter item")),
            "console.open" => {
                if self.retired.contains(id) || self.consoles.contains_key(id) {
                    return Err("Console identity was retired or already opened".into());
                }
                self.consoles.insert(id.into(), VecDeque::new());
                Ok(json!({"resizable":self.config["resizable"] == true}))
            }
            "console.read" => {
                if self.retired.contains(id) {
                    return Ok(json!({"bytes":[],"closed":true}));
                }
                let bytes = self.consoles.get_mut(id).ok_or("Unknown console")?;
                let count = bytes
                    .len()
                    .min(params["maxBytes"].as_u64().unwrap_or(1) as usize);
                let data: Vec<_> = bytes.drain(..count).collect();
                Ok(json!({"bytes":data,"closed":false}))
            }
            "console.write" => {
                let bytes: Vec<u8> =
                    serde_json::from_value(params["bytes"].clone()).map_err(|_| "Invalid bytes")?;
                self.consoles
                    .get_mut(id)
                    .ok_or("Unknown console")?
                    .extend(bytes);
                Ok(Value::Null)
            }
            "console.close" => {
                self.consoles.remove(id);
                self.retired.insert(id.into());
                Ok(Value::Null)
            }
            "console.resize" => {
                if !self.consoles.contains_key(id) {
                    return Err("Unknown console".into());
                }
                Ok(Value::Null)
            }
            "acme.consoleCount" => Ok(json!(self.consoles.len())),
            "acme.openCount" => Ok(json!(self.opens)),
            _ => Err("Unknown fixture operation".into()),
        }
    }
}
