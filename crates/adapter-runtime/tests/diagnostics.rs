// SPDX-License-Identifier: MPL-2.0
use serde_json::json;
use shellcanvas_adapter_runtime::{
    AdapterProcess, DiagnosticKind as Event, DiagnosticStatus, Diagnostics, Launch,
};
use std::{path::PathBuf, time::Duration};
const DEADLINE: Duration = Duration::from_secs(4);
fn launch() -> Launch {
    Launch {
        executable: PathBuf::from(env!("CARGO_BIN_EXE_fixture-adapter")),
        directory: std::env::current_dir().unwrap(),
        arguments: vec!["argument-secret".into()],
    }
}
fn has(log: &Diagnostics, kind: Event) -> bool {
    log.snapshot().events.iter().any(|event| event.kind == kind)
}
async fn wait_for(log: &Diagnostics, kind: Event) {
    tokio::time::timeout(DEADLINE, async {
        while !has(log, kind) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn diagnostics_exclude_configuration_payloads_and_adapter_error_messages() {
    let log = Diagnostics::default();
    let process = AdapterProcess::launch_observed(
        launch(),
        json!({"token":"configuration-secret"}),
        DEADLINE,
        log.clone(),
    )
    .await
    .unwrap();
    assert_eq!(log.snapshot().status, DiagnosticStatus::Connected);
    process
        .call(
            "acme.echo",
            json!({"private":"request-response-secret"}),
            DEADLINE,
        )
        .await
        .unwrap();
    process
        .call(
            "acme.fail",
            json!({"message":"error-message-secret"}),
            DEADLINE,
        )
        .await
        .unwrap_err();
    let encoded = serde_json::to_string(&log.snapshot()).unwrap();
    for private in [
        "configuration-secret",
        "request-response-secret",
        "error-message-secret",
        "argument-secret",
        "acme.echo",
        "acme.fail",
    ] {
        assert!(!encoded.contains(private), "Leaked {private}");
    }
    assert!(has(&log, Event::RequestFailed));
    assert_eq!(log.snapshot().status, DiagnosticStatus::Connected);
    process.close().await.unwrap();
    assert!(has(&log, Event::CleanupConfirmed));
    assert_eq!(log.snapshot().status, DiagnosticStatus::Closed);
    assert!(
        AdapterProcess::launch_observed(launch(), json!({}), DEADLINE, log.clone())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn failed_and_canceled_startup_leave_history_after_process_cleanup() {
    let bad = Diagnostics::default();
    assert!(AdapterProcess::launch_observed(
        launch(),
        json!({"protocol":9}),
        DEADLINE,
        bad.clone()
    )
    .await
    .is_err());
    assert!(has(&bad, Event::InitializationFailed));
    assert!(has(&bad, Event::CleanupConfirmed));
    assert_eq!(bad.snapshot().status, DiagnosticStatus::Failed);
    let log = Diagnostics::default();
    let observing = log.clone();
    let task = tokio::spawn(async move {
        AdapterProcess::launch_observed(launch(), json!({"hang":true}), DEADLINE, observing).await
    });
    wait_for(&log, Event::RequestDispatched).await;
    task.abort();
    assert!(matches!(task.await, Err(reason) if reason.is_cancelled()));
    wait_for(&log, Event::CleanupConfirmed).await;
    assert!(has(&log, Event::InitializationCanceled));
    assert_eq!(log.snapshot().status, DiagnosticStatus::Closed);
}
#[tokio::test]
async fn history_is_bounded_and_does_not_keep_a_process_alive_or_mix_generations() {
    let log = Diagnostics::default();
    let process = AdapterProcess::launch_observed(launch(), json!({}), DEADLINE, log.clone())
        .await
        .unwrap();
    let other = Diagnostics::default();
    let second = AdapterProcess::launch_observed(launch(), json!({}), DEADLINE, other.clone())
        .await
        .unwrap();
    let other_before = serde_json::to_string(&other.snapshot()).unwrap();
    for n in 0..180 {
        process.call("acme.echo", json!(n), DEADLINE).await.unwrap();
    }
    let history = log.snapshot();
    assert_eq!(history.events.len(), 256);
    assert!(history.discarded_events > 0);
    assert_eq!(history.events[0].sequence, history.discarded_events + 1);
    assert!(history
        .events
        .windows(2)
        .all(|events| events[0].sequence + 1 == events[1].sequence
            && events[0].elapsed_ms <= events[1].elapsed_ms));
    assert_eq!(
        serde_json::to_string(&other.snapshot()).unwrap(),
        other_before
    );
    drop(process);
    wait_for(&log, Event::CleanupConfirmed).await;
    second
        .call("acme.echo", json!("independent"), DEADLINE)
        .await
        .unwrap();
    second.close().await.unwrap();
}
#[tokio::test]
async fn timeout_late_reply_and_protocol_failure_remain_distinguishable() {
    let log = Diagnostics::default();
    let process = AdapterProcess::launch_observed(launch(), json!({}), DEADLINE, log.clone())
        .await
        .unwrap();
    assert!(process
        .call(
            "acme.wait",
            json!({"ms":200,"value":"late-private"}),
            Duration::from_millis(30)
        )
        .await
        .is_err());
    wait_for(&log, Event::LateReply).await;
    assert!(has(&log, Event::RequestDeadline));
    assert!(has(&log, Event::RequestCanceled));
    assert!(process
        .call("acme.malformed", json!({}), DEADLINE)
        .await
        .is_err());
    wait_for(&log, Event::CleanupConfirmed).await;
    assert!(has(&log, Event::OutputFailure) || has(&log, Event::InvalidResponse));
    assert_eq!(log.snapshot().status, DiagnosticStatus::Failed);
    assert!(!serde_json::to_string(&log.snapshot())
        .unwrap()
        .contains("late-private"));
}
