// SPDX-License-Identifier: MPL-2.0
// Authorized read-only integration: only temporary shell variables and stty queries.
#[path = "../src/session_registry.rs"]
mod session_registry;
#[path = "../src/terminals.rs"]
mod terminals;
use anyhow::{ensure, Result};
use shellcanvas_core::{ConnectOptions, Connection};
use shellcanvas_services::{TerminalEvent, TerminalInput, TerminalService, TerminalSize};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::mpsc, time::timeout};

async fn wait_output(buffer: &Mutex<Vec<u8>>, marker: &str) -> Result<()> {
    timeout(Duration::from_secs(15), async {
        loop {
            if String::from_utf8_lossy(&buffer.lock().unwrap()).contains(marker) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| anyhow::anyhow!("Console did not return the expected probe response"))
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    ensure!(args.len() == 4, "Usage: terminal_probe HOST USER KEY_PATH");
    let connection = Arc::new(
        Connection::connect(ConnectOptions {
            host: args[1].clone(),
            port: 22,
            username: args[2].clone(),
            key_path: args[3].clone(),
            password: None,
            passphrase: None,
        })
        .await?,
    );
    let service: Arc<dyn TerminalService> = connection.clone();
    let mut registry = session_registry::SessionRegistry::default();
    registry.sessions.insert(1, connection.clone());
    let mut tasks = Vec::new();
    let mut outputs = Vec::new();
    for id in 10..12 {
        let stream = service.open(TerminalSize::new(80, 24)).await?;
        let (sender, input) = mpsc::channel(128);
        let canceled = registry
            .add_terminal(1, id, sender)
            .map_err(anyhow::Error::msg)?;
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let output = bytes.clone();
        tasks.push(tokio::spawn(terminals::run_terminal(
            stream,
            input,
            canceled,
            move |event| {
                if let TerminalEvent::Output(bytes) = event {
                    let mut output = output.lock().unwrap();
                    if output.len() + bytes.len() > 1024 * 1024 {
                        return false;
                    }
                    output.extend(bytes);
                }
                true
            },
        )));
        outputs.push(bytes);
    }
    for (index, label) in ["first", "second"].into_iter().enumerate() {
        let sender = registry
            .sender(1, 10 + index as u64)
            .map_err(anyhow::Error::msg)?;
        let (cols, rows) = if index == 0 { (120, 40) } else { (90, 25) };
        sender.send(TerminalInput::Resize(cols, rows)).await?;
        sender.send(TerminalInput::Data(format!(
            "unset HISTFILE; SHELLCANVAS_CONSOLE_PROBE={label}; printf 'SC_%s:%s\\n' CHANNEL \"$SHELLCANVAS_CONSOLE_PROBE\"; stty size\r"
        ).into_bytes())).await?;
        wait_output(&outputs[index], &format!("SC_CHANNEL:{label}")).await?;
        wait_output(&outputs[index], &format!("{rows} {cols}")).await?;
    }
    println!("Two service-owned SSH consoles: independent input/output and PTY resize OK");
    ensure!(
        registry.sender(2, 10).is_err(),
        "Cross-session access was accepted"
    );
    let retained = registry.sender(1, 10).map_err(anyhow::Error::msg)?;
    registry.close_terminal(1, 10);
    timeout(Duration::from_secs(5), tasks.remove(0)).await??;
    ensure!(
        retained.is_closed(),
        "Retained input handle remained writable after close"
    );
    let sender = registry.sender(1, 11).map_err(anyhow::Error::msg)?;
    sender
        .send(TerminalInput::Data(
            b"printf 'SC_%s:%s\\n' SURVIVOR \"$SHELLCANVAS_CONSOLE_PROBE\"\r".to_vec(),
        ))
        .await?;
    wait_output(&outputs[1], "SC_SURVIVOR:second").await?;
    println!("Closing one console preserves the other; stale/cross-session handles refused");
    registry.remove(1);
    timeout(Duration::from_secs(5), tasks.remove(0)).await??;
    connection.disconnect().await?;
    println!("Console cleanup and SSH disconnect: OK");
    Ok(())
}
