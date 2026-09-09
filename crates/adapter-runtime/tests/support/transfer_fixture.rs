// SPDX-License-Identifier: MPL-2.0
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub fn methods(config: &Value) -> Vec<&'static str> {
    let mut methods = vec![];
    if config["transfers"] == "download" || config["transfers"] == "both" {
        methods.extend([
            "files.download.open",
            "files.download.read",
            "files.download.finish",
        ]);
    }
    if config["transfers"] == "upload" || config["transfers"] == "both" {
        methods.extend([
            "files.upload.open",
            "files.upload.write",
            "files.upload.finish",
        ]);
    }
    if !methods.is_empty() {
        methods.push("files.transfer.abort");
        if config["folders"] == true {
            methods.extend([
                "files.transfer.entry",
                "files.directory.open",
                "files.directory.next",
                "files.directory.finish",
                "files.transfer.mkdir",
            ]);
        }
    }
    methods
}
#[derive(Default)]
pub struct Transfers {
    handles: HashMap<String, Resource>,
    retired: HashSet<String>,
    published: HashMap<String, Vec<u8>>,
    names: HashSet<(String, String)>,
    pub opens: usize,
}
enum Resource {
    Download {
        path: String,
        offset: usize,
    },
    Upload {
        parent: String,
        name: String,
        size: u64,
        bytes: Vec<u8>,
    },
    Directory {
        offset: usize,
    },
}
fn location(path: &str, name: &str) -> Value {
    json!({"path":path,"name":name,"parent":"opaque:destination"})
}
impl Transfers {
    pub fn call(&mut self, method: &str, params: &Value, config: &Value) -> Result<Value, String> {
        let id = params["id"].as_str().unwrap_or("");
        if config["transferFault"] == method {
            return Ok(json!({"malformed":true}));
        }
        match method {
            "acme.transferStats" => {
                return Ok(
                    json!({"active":self.handles.len(),"opens":self.opens,"published":self.published.len()}),
                )
            }
            "files.transfer.abort" => {
                self.retired.insert(id.into());
                self.handles.remove(id);
                return Ok(Value::Null);
            }
            "files.transfer.mkdir" => {
                let parent = params["parent"].as_str().ok_or("Missing parent")?;
                let name = params["name"].as_str().ok_or("Missing name")?;
                if !self.names.insert((parent.into(), name.into())) {
                    return Err("Destination exists".into());
                }
                return Ok(location(
                    &format!("opaque:folder:{}", self.names.len()),
                    name,
                ));
            }
            "files.transfer.entry" => {
                if params["revision"] != "1" {
                    return Err("Stale revision".into());
                }
                let path = params["path"].as_str().ok_or("Missing path")?;
                return Ok(
                    json!({"path":path,"name":"Source","kind":if path=="tree" {"directory"} else {"file"},"revision":"1","size":self.size(path,config),"modified":null}),
                );
            }
            _ => {}
        }
        if method.ends_with(".open") {
            if self.retired.contains(id) || self.handles.contains_key(id) {
                return Err("Retired or duplicate transfer".into());
            }
            let resource = match method {
                "files.download.open" => {
                    if params["revision"] != "1" {
                        return Err("Stale revision".into());
                    }
                    Resource::Download {
                        path: params["path"].as_str().ok_or("Missing path")?.into(),
                        offset: 0,
                    }
                }
                "files.upload.open" => Resource::Upload {
                    parent: params["parent"].as_str().ok_or("Missing parent")?.into(),
                    name: params["name"].as_str().ok_or("Missing name")?.into(),
                    size: params["size"].as_u64().ok_or("Missing size")?,
                    bytes: vec![],
                },
                "files.directory.open" => {
                    if params["revision"] != "1" {
                        return Err("Stale revision".into());
                    }
                    Resource::Directory { offset: 0 }
                }
                _ => return Err("Unknown open".into()),
            };
            let result = match &resource {
                Resource::Download { path, .. } => {
                    json!({"location":location(path,"Source"),"size":self.size(path,config)})
                }
                _ => Value::Null,
            };
            self.handles.insert(id.into(), resource);
            return Ok(result);
        }
        if method == "files.download.read" {
            let Resource::Download { path, offset } =
                self.handles.get(id).ok_or("Missing download")?
            else {
                return Err("Wrong resource".into());
            };
            if params["offset"] != *offset {
                return Err("Wrong offset".into());
            }
            let size = self.size(path, config);
            let end = (*offset + params["maxBytes"].as_u64().unwrap_or(0) as usize).min(size);
            let bytes: Vec<u8> = if let Some(bytes) = self.published.get(path) {
                bytes[*offset..end].to_vec()
            } else {
                (*offset..end).map(|n| (n % 256) as u8).collect()
            };
            if let Some(Resource::Download { offset, .. }) = self.handles.get_mut(id) {
                *offset = end;
            }
            return Ok(json!(bytes));
        }
        if method == "files.upload.write" {
            let Resource::Upload { bytes, size, .. } =
                self.handles.get_mut(id).ok_or("Missing upload")?
            else {
                return Err("Wrong resource".into());
            };
            if params["offset"] != bytes.len() {
                return Err("Wrong offset".into());
            }
            let incoming: Vec<u8> =
                serde_json::from_value(params["bytes"].clone()).map_err(|e| e.to_string())?;
            if bytes.len() as u64 + incoming.len() as u64 > *size {
                return Err("Too many bytes".into());
            }
            bytes.extend(incoming);
            return Ok(Value::Null);
        }
        if method == "files.directory.next" {
            let Resource::Directory { offset } =
                self.handles.get_mut(id).ok_or("Missing directory")?
            else {
                return Err("Wrong resource".into());
            };
            let end = (*offset + 128).min(config["entries"].as_u64().unwrap_or(350) as usize);
            let entries: Vec<_> = (*offset..end).map(|n| json!({"path":format!("opaque:child#{n}"),"name":format!("Child {n}"),"kind":"file","size":0,"revision":"1","modified":null})).collect();
            *offset = end;
            return Ok(json!(entries));
        }
        if method == "files.upload.finish" {
            let Resource::Upload {
                bytes,
                size,
                parent,
                name,
            } = self.handles.get(id).ok_or("Missing upload")?
            else {
                return Err("Wrong resource".into());
            };
            if bytes.len() as u64 != *size {
                return Err("Incomplete upload".into());
            }
            if !self.names.insert((parent.clone(), name.clone())) {
                return Err("Destination exists".into());
            }
            let path = format!("opaque:published:{}", self.names.len());
            let result = location(&path, name);
            self.published.insert(path, bytes.clone());
            self.handles.remove(id);
            self.retired.insert(id.into());
            return Ok(result);
        }
        if method == "files.download.finish" || method == "files.directory.finish" {
            if self.handles.remove(id).is_none() {
                return Err("Missing resource".into());
            }
            self.retired.insert(id.into());
            return Ok(Value::Null);
        }
        Err("Unknown transfer method".into())
    }
    fn size(&self, path: &str, config: &Value) -> usize {
        if path.starts_with("opaque:child#") {
            return 0;
        }
        self.published
            .get(path)
            .map(Vec::len)
            .unwrap_or_else(|| config["bytes"].as_u64().unwrap_or(100_003) as usize)
    }
}
