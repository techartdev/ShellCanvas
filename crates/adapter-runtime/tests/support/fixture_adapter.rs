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
mod transfer_fixture;

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
                    let mut services = json!([{"id":"acme", "version":1, "methods":["acme.echo","acme.wait","acme.fail","acme.crash","acme.malformed","acme.oversize","acme.unknown","acme.cancelCount","acme.calls","acme.waitCount","acme.consoleCount","acme.openCount","acme.arguments","acme.transferStats"]}]);
                    let config = params["configuration"].clone();
                    if config["standard"] == "files" || config["standard"] == "both" {
                        let mut methods = vec!["files.list", "files.locate", "files.preview"];
                        methods.extend(transfer_fixture::methods(&config));
                        if config["extended"] == true {
                            methods.push("files.readText");
                            if config["readOnly"] != true {
                                methods.extend([
                                    "files.createText",
                                    "files.saveText",
                                    "files.makeDirectory",
                                    "files.rename",
                                    "files.remove",
                                    "files.move",
                                ]);
                            }
                        }
                        services
                            .as_array_mut()
                            .unwrap()
                            .push(json!({"id":"files","version":1,"methods":methods}));
                    }
                    if config["standard"] == "console" || config["standard"] == "both" {
                        services.as_array_mut().unwrap().push(json!({"id":"console","version":1,"methods":["console.open","console.read","console.write","console.close","console.resize"]}));
                    }
                    if config["extended"] == true {
                        let methods = if config["readOnly"] == true {
                            vec!["host.settings.read"]
                        } else {
                            vec!["host.settings.read", "host.settings.apply"]
                        };
                        services
                            .as_array_mut()
                            .unwrap()
                            .push(json!({"id":"host","version":1,"methods":methods}));
                    }
                    {
                        let mut device = state.lock().unwrap();
                        device.config = config;
                        device.items.insert(
                            "opaque:note".into(),
                            Item {
                                parent: "opaque:actions".into(),
                                name: "note.txt".into(),
                                text: Some("Original note".into()),
                                revision: 1,
                            },
                        );
                        device.serial = 1;
                    }
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
                    let transfer_delay = {
                        let device = state.lock().unwrap();
                        if device.config["transferDelayMethod"] == method {
                            device.config["transferDelayMs"].as_u64().unwrap_or(250)
                        } else {
                            0
                        }
                    };
                    if transfer_delay > 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(transfer_delay)).await;
                    }
                    if method == "files.download.open"
                        || method == "files.upload.open"
                        || method == "files.directory.open"
                    {
                        let delay = {
                            let mut device = state.lock().unwrap();
                            device.transfers.opens += 1;
                            device.config["transferOpenDelay"].as_u64().unwrap_or(0)
                        };
                        tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                    }
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
    items: HashMap<String, Item>,
    serial: usize,
    mode: Option<String>,
    setting_revision: usize,
    transfers: transfer_fixture::Transfers,
}
struct Item {
    parent: String,
    name: String,
    text: Option<String>,
    revision: usize,
}
impl Item {
    fn document(&self, path: &str) -> Value {
        json!({"path":path,"parent":self.parent,"name":self.name,"text":self.text,"revision":format!("r{}",self.revision),"writable":true})
    }
    fn entry(&self, path: &str) -> Value {
        json!({"path":path,"name":self.name,"kind":if self.text.is_some() {"file"} else {"directory"},"size":self.text.as_ref().map_or(0,String::len),"revision":format!("r{}",self.revision),"modified":null})
    }
}
impl Device {
    fn call(&mut self, method: &str, params: &Value) -> Result<Value, String> {
        if method.starts_with("files.download.")
            || method.starts_with("files.upload.")
            || method.starts_with("files.directory.")
            || method.starts_with("files.transfer.")
            || method == "acme.transferStats"
        {
            return self.transfers.call(method, params, &self.config);
        }
        let id = params["id"].as_str().unwrap_or("");
        if self.config["badStandard"] == method {
            return Ok(json!({"invalid":"fixture"}));
        }
        match method {
            "files.list" => {
                let selected = params["path"].as_str().unwrap_or("");
                if self.config["extended"] == true
                    && (selected == "opaque:actions"
                        || self
                            .items
                            .get(selected)
                            .is_some_and(|item| item.text.is_none()))
                {
                    let entries: Vec<_> = self
                        .items
                        .iter()
                        .filter(|(_, item)| item.parent == selected)
                        .map(|(path, item)| item.entry(path))
                        .collect();
                    return Ok(
                        json!({"directory":{"path":selected,"name":"Actions","parent":null,"home":null,"roots":[],"entries":entries},"next":null}),
                    );
                }
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
            "files.readText" => {
                let path = params["path"].as_str().ok_or("Missing path")?;
                Ok(self.items.get(path).ok_or("Missing item")?.document(path))
            }
            "files.createText" | "files.makeDirectory" => {
                let parent = params["parent"].as_str().ok_or("Missing parent")?;
                let name = params["name"].as_str().ok_or("Missing name")?;
                if self
                    .items
                    .values()
                    .any(|item| item.parent == parent && item.name == name)
                {
                    return Err("Destination exists".into());
                }
                self.serial += 1;
                let path = format!("opaque:new:{}", self.serial);
                let item = Item {
                    parent: parent.into(),
                    name: name.into(),
                    text: if method == "files.createText" {
                        Some(params["text"].as_str().ok_or("Missing text")?.into())
                    } else {
                        None
                    },
                    revision: self.serial,
                };
                let result = if method == "files.createText" {
                    item.document(&path)
                } else {
                    json!(path)
                };
                self.items.insert(path, item);
                Ok(result)
            }
            "files.saveText" | "files.rename" | "files.move" | "files.remove" => {
                let path = params["path"].as_str().ok_or("Missing path")?;
                let item = self.items.get(path).ok_or("Missing item")?;
                if params["revision"] != format!("r{}", item.revision) {
                    return Err("Stale revision".into());
                }
                if method == "files.remove" {
                    self.items.remove(path);
                    return Ok(Value::Null);
                }
                self.serial += 1;
                let item = self.items.get_mut(path).unwrap();
                item.revision = self.serial;
                if method == "files.saveText" {
                    item.text = Some(params["text"].as_str().ok_or("Missing text")?.into());
                    return Ok(item.document(path));
                }
                if method == "files.rename" {
                    item.name = params["name"].as_str().ok_or("Missing name")?.into();
                } else {
                    item.parent = params["parent"].as_str().ok_or("Missing parent")?.into();
                }
                let new_path = format!("opaque:relocated:{}", self.serial);
                let mut locations = vec![
                    json!({"previous":path,"location":{"path":new_path,"parent":item.parent,"name":item.name}}),
                ];
                if let Some(tracked) = params["tracked"].as_array() {
                    for (index, previous) in tracked
                        .iter()
                        .filter(|value| **value != json!(path))
                        .enumerate()
                    {
                        locations.push(json!({"previous":previous,"location":{"path":format!("opaque:mapped:{}:{index}", self.serial),"parent":new_path,"name":"Tracked child"}}));
                    }
                }
                let item = self.items.remove(path).unwrap();
                self.items.insert(new_path.clone(), item);
                Ok(json!({"path":new_path,"locations":locations}))
            }
            "host.settings.read" => Ok(json!([self.setting()])),
            "host.settings.apply" => {
                if params["id"] != "fixture:mode"
                    || params["revision"] != format!("s{}", self.setting_revision)
                {
                    return Err("Stale setting revision".into());
                }
                let value = params["value"].as_str().ok_or("Missing value")?;
                if !["normal", "quiet"].contains(&value) {
                    return Err("Unsupported setting value".into());
                }
                self.mode = Some(value.into());
                self.setting_revision += 1;
                Ok(self.setting())
            }
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
    fn setting(&self) -> Value {
        json!({"id":"fixture:mode","label":"Device mode","description":"Synthetic remote setting","value":self.mode.as_deref().unwrap_or("normal"),"revision":format!("s{}",self.setting_revision),"editor":"select","choices":["normal","quiet"],"writable":true,"reason":null})
    }
}
