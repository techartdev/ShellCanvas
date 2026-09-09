// SPDX-License-Identifier: MPL-2.0
// Synthetic, immutable inventory. These identifiers are NOT local filesystem paths.
use shellcanvas_adapter_sdk::{
    async_trait, json, run, Adapter, CallError, RequestContext, ServiceDescriptor, Value,
};

const ROOT: &str = "inventory:?collection=demo#root";
const REVISION: &str = "inventory-v1";
const COUNT: usize = 300;
struct Device;
fn invalid() -> CallError {
    CallError::new("invalid", "Unknown inventory location or cursor")
}
fn item(index: usize) -> String {
    format!("item:?key={index}#note")
}
fn index(path: &str) -> Result<usize, CallError> {
    let n = path
        .strip_prefix("item:?key=")
        .and_then(|s| s.strip_suffix("#note"))
        .and_then(|s| s.parse::<usize>().ok())
        .ok_or_else(invalid)?;
    if n >= COUNT || item(n) != path {
        return Err(invalid());
    }
    Ok(n)
}
fn location(path: &str) -> Result<Value, CallError> {
    if path == ROOT {
        return Ok(json!({"path":ROOT,"name":"Demo inventory","parent":null}));
    }
    let n = index(path)?;
    Ok(json!({"path":path,"name":format!("Note {n}.txt"),"parent":ROOT}))
}
fn contents(n: usize) -> String {
    format!("Synthetic note {n}. Hello, 🌿!\n")
}

#[async_trait]
impl Adapter for Device {
    async fn initialize(
        &self,
        _: Value,
        _: RequestContext,
    ) -> Result<Vec<ServiceDescriptor>, CallError> {
        Ok(vec![ServiceDescriptor {
            id: "files".into(),
            version: 1,
            methods: [
                "files.list",
                "files.locate",
                "files.preview",
                "files.readText",
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
        if context.is_canceled() {
            return Err(CallError::new("aborted", "Inventory request canceled"));
        }
        let path = match params.get("path") {
            None | Some(Value::Null) => None,
            Some(Value::String(path)) => Some(path.as_str()),
            _ => return Err(invalid()),
        };
        match method {
            "files.list" => {
                if path.is_some_and(|p| p != ROOT) {
                    return Err(invalid());
                }
                let limit = params["limit"]
                    .as_u64()
                    .filter(|n| (1..=128).contains(n))
                    .ok_or_else(invalid)? as usize;
                // Stateless cursor binds to this immutable inventory revision. A mutable
                // device must reject an old revision rather than mix pages from two lists.
                let start = match params.get("cursor") {
                    None | Some(Value::Null) => 0,
                    Some(Value::String(cursor)) => {
                        let offset = cursor
                            .strip_prefix(&format!("{REVISION}:"))
                            .and_then(|s| s.parse::<usize>().ok())
                            .ok_or_else(invalid)?;
                        if offset == 0
                            || offset >= COUNT
                            || *cursor != format!("{REVISION}:{offset}")
                        {
                            return Err(invalid());
                        }
                        offset
                    }
                    _ => return Err(invalid()),
                };
                let end = (start + limit).min(COUNT);
                let entries: Vec<_> = (start..end)
                    .map(|n| {
                        json!({"path":item(n),"name":format!("Note {n}.txt"),
                    "kind":"file","size":contents(n).len(),"modified":null,"revision":REVISION})
                    })
                    .collect();
                Ok(
                    json!({"directory":{"path":ROOT,"name":"Demo inventory","parent":null,
                    "home":{"path":ROOT,"name":"Inventory"},"roots":[{"path":ROOT,"name":"Inventory"}],"entries":entries},
                    "next":if end < COUNT { Some(format!("{REVISION}:{end}")) } else { None }}),
                )
            }
            "files.locate" => location(path.ok_or_else(invalid)?),
            "files.preview" => Ok(json!(contents(index(path.ok_or_else(invalid)?)?))),
            "files.readText" => {
                let path = path.ok_or_else(invalid)?;
                let n = index(path)?;
                Ok(
                    json!({"path":path,"parent":ROOT,"name":format!("Note {n}.txt"),"text":contents(n),
                    "revision":REVISION,"writable":false}),
                )
            }
            _ => Err(CallError::new(
                "unavailable",
                "Unsupported inventory operation",
            )),
        }
    }
}
fn main() -> std::io::Result<()> {
    run(Device)
}
