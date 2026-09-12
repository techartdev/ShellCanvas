# Connecting to Home Assistant

ShellCanvas can connect to Home Assistant through the **Terminal & SSH** add-on using its existing SSH service. No ShellCanvas-specific agent is needed on Home Assistant.

## Setup

1. Install **Terminal & SSH** from Home Assistant's app/add-on store. This guide refers to the official Home Assistant add-on.
2. Generate an SSH key pair on your computer, or use an existing compatible pair. Add the **public** key to the add-on's `authorized_keys` configuration. Keep the private key on your computer. Leave `password` empty when using key authentication.
3. In the add-on's **Network** configuration, assign an SSH TCP port, such as `22`. Network SSH access is disabled until a port is configured; opening the web terminal alone is not enough. Save and start/restart the add-on.
4. In ShellCanvas, choose **Add host** and enter:
   - A recognizable name, such as `Home Assistant`.
   - Your Home Assistant device's reachable address.
   - The SSH port configured above, rather than the Home Assistant web interface port.
   - Username `root`.
   - Your local private-key path and its passphrase, if applicable.
5. Verify the SSH host identity when prompted, save the host, and open its workspace. Try **Files** and **Terminal**.

For key setup and current configuration details, see the [official Terminal & SSH documentation](https://github.com/home-assistant/addons/blob/master/ssh/DOCS.md). ShellCanvas's [host-profile guide](host-profiles.md) and [SSH trust reference](ssh-host-trust.md) explain the client-side workflow.

## What this connection exposes

The SSH session runs inside the add-on's container. Files and commands are limited to what that environment exposes; connecting as `root` does not make this an unrestricted SSH session into the underlying Home Assistant OS. The official add-on documents `/config` as the configuration directory and includes the Home Assistant CLI (`ha help`).

## Reported compatibility check

On 2026-09-12, a user successfully connected from the Windows ShellCanvas desktop after installing Terminal & SSH and configuring SSH keys. Their screenshots showed:

- Home Assistant OS **17.3** and Home Assistant Core **2026.6.4** in the terminal banner.
- An interactive terminal with the Home Assistant CLI welcome message.
- File browsing at `/`, including exposed Home Assistant directories.
- Host details reporting the add-on hostname `core-ssh`, a Linux provider, and home directory `/root`.

This confirms SSH login, terminal use, and file browsing for that setup. It does not yet verify file editing, transfers, drive mounting, or a dedicated Home Assistant integration. The Linux provider label describes the detected environment; it is not Home Assistant-specific device detection.
