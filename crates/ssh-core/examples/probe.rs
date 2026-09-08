// SPDX-License-Identifier: MPL-2.0
// Read-only integration probe. Never prints credentials or remote file contents.
use shellcanvas_core::*;
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    anyhow::ensure!(args.len() == 4, "Usage: probe HOST USER KEY_PATH");
    let connection = Connection::connect(ConnectOptions {
        host: args[1].clone(),
        port: 22,
        username: args[2].clone(),
        key_path: args[3].clone(),
        password: None,
        passphrase: None,
    })
    .await?;
    let info = inspect_host(&connection).await;
    println!("SSH authentication and known-host verification: OK");
    println!("Provider: {}; system: {}", info.provider, info.system);
    let sftp = SftpFileSystem(connection.sftp().await?);
    let home = sftp.list(None).await?;
    println!("SFTP home listing: OK ({} entries)", home.entries.len());
    anyhow::ensure!(
        home.home
            .as_ref()
            .is_some_and(|place| place.path == home.path),
        "Home metadata does not match the default location"
    );
    for root in &home.roots {
        anyhow::ensure!(
            sftp.list(Some(&root.path)).await?.parent.is_none(),
            "Root unexpectedly has a parent"
        );
    }
    if let Some(parent) = &home.parent {
        anyhow::ensure!(
            !sftp.list(Some(parent)).await?.path.is_empty(),
            "Parent navigation failed"
        );
    }
    let location = sftp.locate("/etc/os-release").await?;
    anyhow::ensure!(
        !location.name.is_empty() && location.parent.is_some(),
        "File location metadata is incomplete"
    );
    let text = connection
        .text_files()
        .await?
        .read_text("/etc/os-release")
        .await?;
    anyhow::ensure!(
        text.path == location.path && text.name == location.name && text.parent == location.parent,
        "Text and browsing services disagree on canonical location"
    );
    println!("Provider home/root/parent and canonical text locations: OK");
    let os_release = sftp.preview("/etc/os-release").await?;
    println!("Read-only UTF-8 preview: OK ({} bytes)", os_release.len());
    let mut terminal = connection.terminal(100, 30).await?;
    terminal.window_change(120, 40, 0, 0).await?;
    terminal
        .data(&b"unset HISTFILE; printf 'SHELL%s\\n' CANVAS_PROBE_OK; stty size; exit\r"[..])
        .await?;
    let output = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        let mut bytes = Vec::new();
        while let Some(message) = terminal.wait().await {
            if let russh::ChannelMsg::Data { data } = message {
                bytes.extend_from_slice(&data);
            }
        }
        bytes
    })
    .await?;
    let output = String::from_utf8_lossy(&output);
    anyhow::ensure!(
        output.contains("SHELLCANVAS_PROBE_OK"),
        "Shell did not return the probe marker"
    );
    anyhow::ensure!(output.contains("40 120"), "PTY dimensions were not applied");
    println!("PTY allocation, shell input/output, and resize: OK");
    connection.disconnect().await?;
    println!("Disconnect: OK");
    Ok(())
}
