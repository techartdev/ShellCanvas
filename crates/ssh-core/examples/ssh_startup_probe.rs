// SPDX-License-Identifier: MPL-2.0
//! Read-only startup diagnostics; no files or settings are modified remotely.
use shellcanvas_core::*;
use std::{path::PathBuf, sync::Arc};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(
        args.len() == 5,
        "Usage: ssh_startup_probe HOST USER KEY_PATH APP_KNOWN_HOSTS"
    );
    let options = ConnectOptions {
        host: args[1].clone(),
        port: 22,
        username: args[2].clone(),
        key_path: args[3].clone(),
        password: None,
        passphrase: None,
        allow_legacy_mac: true,
    };
    let mut connection =
        Arc::new(Connection::connect_with_trust_store(&options, PathBuf::from(&args[4])).await?);
    println!(
        "Authenticated; connected={}",
        !connection.handle.is_closed()
    );
    let info = inspect_host(&connection).await;
    println!(
        "Inspected: provider={}, system={}; connected={}",
        info.provider,
        info.system,
        !connection.handle.is_closed()
    );
    for notice in &info.notices {
        println!("Notice: {notice}");
    }
    if !connection.handle.is_closed() {
        match connection.text_files().await {
            Ok(service) => {
                println!(
                    "SFTP initialized; connected={}",
                    !connection.handle.is_closed()
                );
                let browser = SftpBrowser(Arc::new(service));
                println!(
                    "SFTP home resolved={}; connected={}",
                    browser.canonicalize(".").await.is_ok(),
                    !connection.handle.is_closed()
                );
            }
            Err(error) => println!(
                "SFTP failed: {error:#}; connected={}",
                !connection.handle.is_closed()
            ),
        }
    }
    if connection.handle.is_closed() {
        connection = Arc::new(connection.reconnect(&options).await?);
        println!(
            "Recovered with the same verified host key; connected={}",
            !connection.handle.is_closed()
        );
    }
    // Allocate and close a terminal without sending input or displaying its
    // banner/history. This is the operation the recovered workspace needs.
    let terminal = connection.terminal(80, 24).await?;
    println!(
        "Terminal opened; connected={}",
        !connection.handle.is_closed()
    );
    terminal.close().await?;
    connection.disconnect().await?;
    Ok(())
}
