// SPDX-License-Identifier: MPL-2.0
use shellcanvas_adapter_sdk::{
    async_trait, json, serve,
    wire::{self, Envelope},
    Adapter, CallError, RequestContext, ServiceDescriptor, Value,
};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncWriteExt, DuplexStream},
    sync::Notify,
    task::JoinHandle,
};

#[derive(Clone, Default)]
struct Device {
    calls: Arc<AtomicUsize>,
    stopped: Arc<AtomicUsize>,
    release: Arc<Notify>,
}
#[async_trait]
impl Adapter for Device {
    async fn initialize(
        &self,
        config: Value,
        _: RequestContext,
    ) -> Result<Vec<ServiceDescriptor>, CallError> {
        Ok(vec![ServiceDescriptor {
            id: if config["invalid"] == true {
                "system"
            } else {
                "example.device"
            }
            .into(),
            version: 1,
            methods: ["echo", "wait", "badError"]
                .map(|method| format!("example.device.{method}"))
                .to_vec(),
        }])
    }
    async fn call(
        &self,
        method: &str,
        params: Value,
        context: RequestContext,
    ) -> Result<Value, CallError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match method {
            "example.device.wait" => {
                tokio::select! {
                    _ = context.canceled() => {
                        self.stopped.fetch_add(1, Ordering::SeqCst);
                        Err(CallError::new("aborted", "Canceled"))
                    }
                    _ = self.release.notified() => Ok(json!("released")),
                }
            }
            "example.device.badError" => {
                Err(CallError::new("invented", "Do not expose an invalid error"))
            }
            _ => Ok(params),
        }
    }
}
type Connection = (DuplexStream, DuplexStream, JoinHandle<std::io::Result<()>>);
fn launch(device: Device) -> Connection {
    let (write, input) = tokio::io::duplex(65536);
    let (output, read) = tokio::io::duplex(65536);
    (write, read, tokio::spawn(serve(device, input, output)))
}
async fn send(write: &mut DuplexStream, message: Envelope) {
    wire::write_frame(write, &wire::encode(&message).unwrap())
        .await
        .unwrap();
}
fn request(id: u64, method: &str, params: Value) -> Envelope {
    Envelope::Request {
        v: 1,
        id,
        method: method.into(),
        params,
    }
}
async fn reply(read: &mut DuplexStream) -> Envelope {
    tokio::time::timeout(Duration::from_secs(3), wire::read_frame(read))
        .await
        .unwrap()
        .unwrap()
}
async fn initialize(write: &mut DuplexStream, read: &mut DuplexStream) {
    send(
        write,
        request(
            1,
            "system.adapter.initialize",
            json!({"protocol":1,"configuration":{}}),
        ),
    )
    .await;
    assert!(matches!(reply(read).await, Envelope::Result { id: 1, .. }));
}
async fn count(counter: &AtomicUsize, expected: usize) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while counter.load(Ordering::SeqCst) != expected {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn cancellation_and_unknown_methods_do_not_block_an_independent_call() {
    let device = Device::default();
    let (mut write, mut read, server) = launch(device.clone());
    initialize(&mut write, &mut read).await;
    send(&mut write, request(2, "example.device.wait", Value::Null)).await;
    count(&device.calls, 1).await;
    send(
        &mut write,
        request(3, "example.device.echo", json!([0, 255, 17])),
    )
    .await;
    assert!(
        matches!(reply(&mut read).await, Envelope::Result {id: 3, value, ..} if value == json!([0,255,17]))
    );
    send(&mut write, request(4, "other.device.read", Value::Null)).await;
    assert!(
        matches!(reply(&mut read).await, Envelope::Error {id: 4, code, ..} if code == "unavailable")
    );
    assert_eq!(device.calls.load(Ordering::SeqCst), 2);
    send(&mut write, Envelope::Cancel { v: 1, id: 2 }).await;
    assert!(
        matches!(reply(&mut read).await, Envelope::Error {id: 2, code, ..} if code == "aborted")
    );
    count(&device.stopped, 1).await;
    send(
        &mut write,
        request(5, "example.device.badError", Value::Null),
    )
    .await;
    assert!(
        matches!(reply(&mut read).await, Envelope::Error {code, message, ..} if code == "failed" && message == "Adapter returned an invalid error")
    );
    drop(write);
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn capacity_is_recovered_after_cancellation_and_pipe_close_signals_cleanup() {
    let device = Device::default();
    let (mut write, mut read, server) = launch(device.clone());
    initialize(&mut write, &mut read).await;
    for id in 2..34 {
        send(&mut write, request(id, "example.device.wait", Value::Null)).await;
    }
    count(&device.calls, 32).await;
    send(&mut write, request(34, "example.device.echo", Value::Null)).await;
    assert!(matches!(reply(&mut read).await, Envelope::Error {id: 34, code, ..} if code == "busy"));
    for id in 2..34 {
        send(&mut write, Envelope::Cancel { v: 1, id }).await;
    }
    for _ in 2..34 {
        assert!(matches!(reply(&mut read).await, Envelope::Error {code, ..} if code == "aborted"));
    }
    send(
        &mut write,
        request(35, "example.device.echo", json!("recovered")),
    )
    .await;
    assert!(matches!(
        reply(&mut read).await,
        Envelope::Result { id: 35, .. }
    ));
    send(&mut write, request(36, "example.device.wait", Value::Null)).await;
    count(&device.calls, 34).await;
    drop(write);
    tokio::time::timeout(Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(device.stopped.load(Ordering::SeqCst), 33);
}

#[tokio::test]
async fn completing_a_call_during_a_partial_frame_does_not_corrupt_the_reader() {
    let device = Device::default();
    let (mut write, mut read, server) = launch(device.clone());
    initialize(&mut write, &mut read).await;
    send(&mut write, request(2, "example.device.wait", Value::Null)).await;
    count(&device.calls, 1).await;
    let bytes = wire::encode(&request(3, "example.device.echo", json!("fragmented"))).unwrap();
    let header = (bytes.len() as u32).to_be_bytes();
    write.write_all(&header[..2]).await.unwrap();
    device.release.notify_one();
    assert!(matches!(
        reply(&mut read).await,
        Envelope::Result { id: 2, .. }
    ));
    write.write_all(&header[2..]).await.unwrap();
    for byte in bytes {
        write.write_u8(byte).await.unwrap();
        tokio::task::yield_now().await;
    }
    assert!(
        matches!(reply(&mut read).await, Envelope::Result {id: 3, value, ..} if value == "fragmented")
    );
    drop(write);
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn malformed_negotiation_catalogs_and_replayed_requests_are_refused() {
    for configuration in [json!({"invalid":true}), json!({})] {
        let (mut write, mut read, server) = launch(Device::default());
        let invalid_catalog = configuration["invalid"] == true;
        send(
            &mut write,
            request(
                1,
                "system.adapter.initialize",
                json!({"protocol":1,"configuration":configuration}),
            ),
        )
        .await;
        assert_eq!(
            matches!(reply(&mut read).await, Envelope::Error {code, ..} if code == "invalid"),
            invalid_catalog
        );
        send(&mut write, request(1, "example.device.echo", Value::Null)).await;
        assert!(server.await.unwrap().is_err());
    }
    let (mut write, mut read, server) = launch(Device::default());
    send(
        &mut write,
        request(
            1,
            "system.adapter.initialize",
            json!({"protocol":2,"configuration":{}}),
        ),
    )
    .await;
    assert!(matches!(reply(&mut read).await, Envelope::Error {code, ..} if code == "invalid"));
    drop(write);
    server.await.unwrap().unwrap();
}

#[tokio::test]
async fn truncated_headers_and_bodies_are_errors_but_empty_eof_is_clean() {
    for bytes in [vec![0, 0], vec![0, 0, 0, 4, b'{'], vec![0, 0, 0, 0]] {
        let (mut write, _read, server) = launch(Device::default());
        write.write_all(&bytes).await.unwrap();
        drop(write);
        assert!(server.await.unwrap().is_err());
    }
    let (write, _read, server) = launch(Device::default());
    drop(write);
    server.await.unwrap().unwrap();
}
