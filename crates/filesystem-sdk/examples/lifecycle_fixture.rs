// SPDX-License-Identifier: MPL-2.0
//! Synthetic child-process acceptance fixture. No filesystem or driver access.
use shellcanvas_filesystem_sdk::{
    bridge_control::{BridgeDirective, BridgeEvent},
    wire::{Client, Operation, Value},
};
use std::{
    io::{self, Write},
    thread,
    time::Duration,
};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mode = std::env::args().nth(1).unwrap_or_default();
    match mode.as_str() {
        "stall" => {
            thread::sleep(Duration::from_secs(120));
            return Ok(());
        }
        "invalid" => {
            let payload = br#"{"version":999,"id":1,"operation":{"method":"Capabilities"}}"#;
            let mut out = io::stdout().lock();
            out.write_all(&(payload.len() as u32).to_be_bytes())?;
            out.write_all(payload)?;
            out.flush()?;
            thread::sleep(Duration::from_secs(120));
            return Ok(());
        }
        "busy" => {}
        _ => return Err("Choose busy, invalid or stall".into()),
    }
    // A child filling stderr must not block its protocol pipe.
    eprint!("{}", "fixture diagnostic; ".repeat(8000));
    let client = Client::new(io::stdin(), io::stdout());
    client.call(Operation::Capabilities)?;
    client.call(Operation::Report {
        event: BridgeEvent::Ready,
    })?;
    let mut refused = false;
    loop {
        match client.call(Operation::Poll)? {
            Value::Directive(BridgeDirective::Detach) => {
                if refused {
                    client.call(Operation::Report {
                        event: BridgeEvent::Detached,
                    })?;
                    return Ok(());
                }
                refused = true;
                client.call(Operation::Report {
                    event: BridgeEvent::DetachFailed {
                        message: "Fixture file is busy".into(),
                    },
                })?;
            }
            Value::Directive(BridgeDirective::Continue) => {}
            _ => return Err("Unexpected reply".into()),
        }
        thread::sleep(Duration::from_millis(20));
    }
}
