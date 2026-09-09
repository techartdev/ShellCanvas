// SPDX-License-Identifier: MPL-2.0
use serde_json::json;
use shellcanvas_adapter_runtime::{AdapterProcess, Launch};
use std::{path::PathBuf, time::Duration};

fn executable() -> PathBuf {
    std::env::var_os("SHELLCANVAS_SDK_ADAPTER_EXE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_BIN_EXE_sdk-adapter")))
}

#[tokio::test]
async fn sdk_server_works_with_the_production_host_and_cancels_without_retiring_it() {
    let executable = executable();
    let process = AdapterProcess::launch(
        Launch {
            directory: executable.parent().unwrap().into(),
            executable,
            arguments: vec![],
        },
        json!({}),
        Duration::from_secs(3),
    )
    .await
    .unwrap();
    let device = process.custom("example.device").unwrap();
    let waiting = process.call("example.device.wait", json!({}), Duration::from_millis(100));
    let echo = process.call(
        "example.device.echo",
        json!([0, 255, "Unicode λ"]),
        Duration::from_secs(3),
    );
    let (waiting, echo) = tokio::join!(waiting, echo);
    assert!(waiting.is_err());
    assert_eq!(echo.unwrap(), json!([0, 255, "Unicode λ"]));
    assert_eq!(
        device
            .call("example.device.echo", json!("still alive"))
            .await
            .unwrap(),
        json!("still alive")
    );
    process.close().await.unwrap();
    assert!(!process.connected());
}

#[tokio::test]
async fn sdk_executable_exits_after_invalid_input_even_while_the_host_pipe_is_open() {
    use shellcanvas_adapter_runtime::wire::{self, Envelope};
    use std::process::Stdio;
    let mut command = tokio::process::Command::new(executable());
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().unwrap();
    let mut input = child.stdin.take().unwrap();
    let invalid = Envelope::Request {
        v: 1,
        id: 1,
        method: "example.device.echo".into(),
        params: json!({}),
    };
    wire::write_frame(&mut input, &wire::encode(&invalid).unwrap())
        .await
        .unwrap();
    // Retain input: a failed adapter must not wait for the host to close stdin.
    let exit = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
    drop(input);
    assert!(!exit
        .expect("SDK executable hung after protocol failure")
        .unwrap()
        .success());
}
