// SPDX-License-Identifier: MPL-2.0
use serde_json::{json, Value};
use shellcanvas_adapter_runtime::{wire::MAX_FRAME, AdapterProcess, Launch};
use std::{path::PathBuf, time::Duration};
const DEADLINE: Duration = Duration::from_secs(4);
fn launch() -> Launch {
    Launch {
        executable: PathBuf::from(env!("CARGO_BIN_EXE_fixture-adapter")),
        arguments: vec![],
        directory: std::env::current_dir().unwrap(),
    }
}
async fn fixture() -> AdapterProcess {
    AdapterProcess::launch(launch(), json!({}), DEADLINE)
        .await
        .unwrap()
}

#[tokio::test]
async fn launch_uses_absolute_executables_and_literal_arguments() {
    let mut relative = launch();
    relative.executable = PathBuf::from("fixture-adapter.exe");
    assert!(
        matches!(AdapterProcess::launch(relative,Value::Null,DEADLINE).await,Err(error) if error.code == "invalid")
    );
    #[cfg(windows)]
    for suffix in ["cmd", "BAT", "lnk"] {
        let mut batch = launch();
        batch.executable.set_extension(suffix);
        assert!(
            matches!(AdapterProcess::launch(batch,Value::Null,DEADLINE).await,Err(error) if error.code == "invalid")
        );
    }
    let mut specification = launch();
    let arguments = vec![
        "a b",
        "quote\"here",
        "$HOME",
        "%PATH%",
        "one&two",
        "trailing\\",
    ];
    specification.arguments = arguments.iter().map(|value| value.to_string()).collect();
    let adapter = AdapterProcess::launch(specification, Value::Null, DEADLINE)
        .await
        .unwrap();
    assert_eq!(
        adapter
            .call("acme.arguments", Value::Null, DEADLINE)
            .await
            .unwrap(),
        json!(arguments)
    );
    adapter.close().await.unwrap();
}

#[tokio::test]
async fn concurrent_work_is_bounded_and_dropping_calls_releases_capacity() {
    use std::{
        future::{poll_fn, Future},
        task::Poll,
    };
    let adapter = fixture().await;
    let mut calls: Vec<_> = (0..32)
        .map(|_| Box::pin(adapter.call("acme.wait", json!({"ms":1000}), DEADLINE)))
        .collect();
    poll_fn(|cx| {
        for call in &mut calls {
            assert!(call.as_mut().poll(cx).is_pending());
        }
        Poll::Ready(())
    })
    .await;
    assert_eq!(
        adapter
            .call("acme.echo", Value::Null, DEADLINE)
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    drop(calls);
    tokio::time::timeout(DEADLINE, async {
        loop {
            match adapter
                .call("acme.echo", json!("capacity returned"), DEADLINE)
                .await
            {
                Ok(value) => {
                    assert_eq!(value, "capacity returned");
                    break;
                }
                Err(error) => {
                    assert_eq!(error.code, "busy");
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }
        }
    })
    .await
    .unwrap();
    adapter.close().await.unwrap();
}

#[tokio::test]
async fn explicit_close_retires_pending_work_and_all_waiters_observe_cleanup() {
    let adapter = fixture().await;
    let cloned = adapter.clone();
    let pending =
        tokio::spawn(async move { cloned.call("acme.wait", json!({"ms":2000}), DEADLINE).await });
    tokio::time::timeout(DEADLINE, async {
        loop {
            if adapter
                .call("acme.waitCount", Value::Null, DEADLINE)
                .await
                .unwrap()
                == 1
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let (first, second) = tokio::join!(adapter.close(), adapter.close());
    first.unwrap();
    second.unwrap();
    let error = pending.await.unwrap().unwrap_err();
    assert_eq!(error.code, "closed");
    assert!(error.outcome_uncertain);
}

#[tokio::test]
async fn independent_processes_route_custom_services_and_out_of_order_results() {
    let first = fixture().await;
    let second = fixture().await;
    assert!(first.supports("acme", 1, &["acme.echo"]));
    assert!(!first.supports("files", 1, &["files.list"]));
    let (slow, fast) = tokio::join!(
        first.call("acme.wait", json!({"ms":100,"value":"slow"}), DEADLINE),
        first.call("acme.echo", json!("fast"), DEADLINE)
    );
    assert_eq!(slow.unwrap(), "slow");
    assert_eq!(fast.unwrap(), "fast");
    let bytes = json!("🌿\u{1}".repeat(150_000));
    assert_eq!(
        first
            .call("acme.echo", bytes.clone(), DEADLINE)
            .await
            .unwrap(),
        bytes
    );
    let missing = first
        .call("files.list", Value::Null, DEADLINE)
        .await
        .unwrap_err();
    assert_eq!(missing.code, "unavailable");
    assert!(!missing.outcome_uncertain);
    first.close().await.unwrap();
    assert!(!first.connected());
    assert_eq!(
        first
            .call("acme.echo", json!(1), DEADLINE)
            .await
            .unwrap_err()
            .code,
        "closed"
    );
    assert_eq!(
        second.call("acme.echo", json!(2), DEADLINE).await.unwrap(),
        2
    );
    second.close().await.unwrap();
}
#[tokio::test]
async fn protocol_negotiation_rejects_incompatible_or_duplicate_catalogs_and_hung_start() {
    for configuration in [json!({"protocol":2}), json!({"duplicate":true})] {
        let result = AdapterProcess::launch(launch(), configuration, DEADLINE).await;
        assert!(matches!(result, Err(ref error) if error.code == "unavailable"));
    }
    let result =
        AdapterProcess::launch(launch(), json!({"hang":true}), Duration::from_millis(150)).await;
    assert!(matches!(result, Err(ref error) if error.code == "deadline"));
}
#[tokio::test]
async fn deadline_and_dropped_future_cancel_only_their_call_and_ignore_late_replies() {
    let adapter = fixture().await;
    let timeout = adapter
        .call(
            "acme.wait",
            json!({"ms":250,"value":"late"}),
            Duration::from_millis(50),
        )
        .await
        .unwrap_err();
    assert_eq!(timeout.code, "deadline");
    assert!(timeout.outcome_uncertain);
    let cloned = adapter.clone();
    let task = tokio::spawn(async move {
        cloned
            .call("acme.wait", json!({"ms":250,"value":"abandoned"}), DEADLINE)
            .await
    });
    // Wait until the fixture has observed both waits, rather than assuming dispatch timing.
    loop {
        if adapter
            .call("acme.waitCount", Value::Null, DEADLINE)
            .await
            .unwrap()
            .as_u64()
            .unwrap()
            >= 2
        {
            break;
        }
        tokio::task::yield_now().await;
    }
    task.abort();
    let _ = task.await;
    tokio::time::timeout(DEADLINE, async {
        loop {
            if adapter
                .call("acme.cancelCount", Value::Null, DEADLINE)
                .await
                .unwrap()
                .as_u64()
                .unwrap()
                >= 2
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        adapter
            .call("acme.echo", json!("still current"), DEADLINE)
            .await
            .unwrap(),
        "still current"
    );
    adapter.close().await.unwrap();
}
#[tokio::test]
async fn malformed_output_crash_and_unsolicited_reply_close_only_the_owning_generation() {
    for method in [
        "acme.crash",
        "acme.malformed",
        "acme.oversize",
        "acme.unknown",
    ] {
        let old = fixture().await;
        let surviving = fixture().await;
        let (failed, pending) = tokio::join!(
            old.call(method, Value::Null, DEADLINE),
            old.call("acme.wait", json!({"ms":1000}), DEADLINE)
        );
        assert_eq!(failed.unwrap_err().code, "closed");
        assert_eq!(pending.unwrap_err().code, "closed");
        assert!(!old.connected());
        old.close().await.unwrap();
        assert_eq!(
            surviving
                .call("acme.echo", json!("other connection"), DEADLINE)
                .await
                .unwrap(),
            "other connection"
        );
        surviving.close().await.unwrap();
    }
}
#[tokio::test]
async fn rejected_requests_do_not_poison_the_connection_or_retry_mutations() {
    let adapter = fixture().await;
    let denied = adapter
        .call("acme.fail", Value::Null, DEADLINE)
        .await
        .unwrap_err();
    assert_eq!(denied.code, "denied");
    let invalid = adapter
        .call("acme.echo", json!("x".repeat(MAX_FRAME)), DEADLINE)
        .await
        .unwrap_err();
    assert_eq!(invalid.code, "invalid");
    assert!(!invalid.outcome_uncertain);
    let deadline = adapter
        .call("acme.echo", json!("never sent"), Duration::ZERO)
        .await
        .unwrap_err();
    assert!(!deadline.outcome_uncertain);
    assert_eq!(
        adapter
            .call("acme.calls", Value::Null, DEADLINE)
            .await
            .unwrap(),
        3
    ); // initialize, fail, calls
    adapter.close().await.unwrap();
    adapter.close().await.unwrap();
}
