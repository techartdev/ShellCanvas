// SPDX-License-Identifier: MPL-2.0
//! Read-only device identification, inventory and SFTP namespace acceptance.
use shellcanvas_core::*;
use std::{path::PathBuf, sync::Arc};
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().collect();
    anyhow::ensure!(args.len() == 5, "Usage: volumes HOST USER KEY_PATH ADDITIONAL_KNOWN_HOSTS (optional password from SHELLCANVAS_PROBE_PASSWORD)");
    let options = ConnectOptions {
        host: args[1].clone(),
        port: 22,
        username: args[2].clone(),
        key_path: args[3].clone(),
        password: std::env::var("SHELLCANVAS_PROBE_PASSWORD").ok(),
        passphrase: None,
    };
    let connection =
        Arc::new(Connection::connect_with_trust_store(&options, PathBuf::from(&args[4])).await?);
    let info = inspect_host(&connection).await;
    println!("Identified: {} ({})", info.provider, info.system);
    let browser = Arc::new(SshFileBrowser::new(
        Arc::new(SftpBrowser(Arc::new(connection.text_files().await?))),
        connection.clone(),
    ));
    let inventory = browser.volumes().await?;
    println!(
        "Volumes: {}; notices: {:?}",
        inventory.volumes.len(),
        inventory.notices
    );
    anyhow::ensure!(!inventory.volumes.is_empty(), "No volumes discovered");
    let mut checked = 0;
    for volume in &inventory.volumes {
        for location in volume
            .locations
            .iter()
            .filter(|p| !volume.system || p.path == "/")
        {
            let mut reader = browser.clone().open_directory(Some(&location.path)).await?;
            let page = reader.next().await?;
            anyhow::ensure!(!page.directory.path.is_empty(), "Empty location");
            reader.close().await?;
            checked += 1;
        }
    }
    println!("Mounted locations opened via SFTP: {checked}. No mount/unmount commands were sent.");
    connection.disconnect().await?;
    Ok(())
}
