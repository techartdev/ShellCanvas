// SPDX-License-Identifier: MPL-2.0
// Read-only probe: never calls apply and never changes host configuration.
use anyhow::{ensure, Context};
use shellcanvas_core::*;
use std::sync::Arc;
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    ensure!(args.len() == 4, "Usage: settings_probe HOST USER KEY_PATH");
    let connection = Arc::new(
        Connection::connect(ConnectOptions {
            host: args[1].clone(),
            port: 22,
            username: args[2].clone(),
            key_path: args[3].clone(),
            password: None,
            allow_legacy_mac: false,
            passphrase: None,
        })
        .await?,
    );
    let info = inspect_host(&connection).await;
    let provider = settings_for_host(&info.provider, Some(connection.clone()))
        .context("No settings provider for this host")?;
    let fields = provider.read().await?;
    ensure!(
        fields.len() == 2,
        "Expected two settings on the Linux probe host"
    );
    for field in &fields {
        ensure!(
            field.value.is_some() && field.revision.is_some(),
            "{} unavailable: {:?}",
            field.id,
            field.reason
        );
        if matches!(field.editor, SettingEditor::Select) {
            ensure!(
                field.choices.contains(field.value.as_ref().unwrap()),
                "Current timezone not among host choices"
            );
        }
        println!(
            "{}: read OK, {} choices, writable account: {}",
            field.id,
            field.choices.len(),
            field.writable
        );
    }
    let again = provider.read().await?;
    ensure!(
        fields
            .iter()
            .zip(again.iter())
            .all(|(a, b)| a.id == b.id && a.revision == b.revision),
        "Settings changed between read-only inspections"
    );
    connection.disconnect().await?;
    println!("Read-only settings inspection and disconnect: OK. No settings changed.");
    Ok(())
}
