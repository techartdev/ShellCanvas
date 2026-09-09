# Saved workspace profiles

Open **Connect a host → Use connection adapters**. The **Saved workspace** selector loads a saved set of connections and explicit service assignments. Choose **SSH (built in)** or an installed adapter for each source, then assign Files, Terminal, Remote settings or additional services. For example, keep Terminal on SSH while Files comes from an installed adapter. Choose **New workspace** to start another profile. Saving is explicit and does not connect to a device.

**Save workspace profile** stores the current name, adapter identities, reviewed package revisions, public configuration and service assignments. **Save profile changes** updates the selected profile. Password fields are omitted by the native store using the installed adapter's schema, even if the caller sends them. Required passwords may be left empty when saving; enter them before connecting. This is configuration storage, not a credential vault.

Reopening a profile fills only fields still declared public by the installed adapter. Removed fields, incompatible types and fields reclassified as passwords are not prefilled. A changed package, disabled adapter or missing adapter produces a review notice. A missing adapter is not silently replaced. Users can explicitly select another installed adapter and review its settings. The final connection still validates the current package revision and configuration before launching it.

**Remove saved profile** requires a second confirmation. Removing or editing a profile does not alter an already-running workspace, its service sources, terminal state or editor drafts. Reconnect and source replacement retain their existing in-memory binding rules; saving a profile does not weaken them.

## Persistence and concurrency

The native application-data directory contains `workspaces.json` and `workspaces.lock`. This store is separate from saved SSH hosts and installed adapter packages. Version 1 uses a tagged profile kind (`adapters`), whose sources can include the reserved `builtin:ssh` identity. Installed package IDs cannot use this reserved identity. Existing saved SSH profiles keep their current flow.

SSH uses the same host-key verification as the ordinary SSH connection dialog. Unknown keys require endpoint-specific fingerprint review; changed or revoked keys remain blocked. Each SSH source is reviewed separately. Passwords and key passphrases are omitted from profiles; private-key paths are public configuration. Replacing one source prepares its connection before committing the change, so a preparation failure preserves the existing workspace. Unrelated source handles remain usable after a successful replacement.

Profiles have UUID identities and revisions. Update and removal require the revision the caller reviewed; concurrent changes cause an error rather than replacing another window's changes. Close and reopen the connection dialog to reload current profiles after a conflict. Cross-process locking protects read/modify/write, and a synced temporary file is atomically published. Malformed files, future versions, duplicate identities and invalid bindings are refused without rewriting the original file. A 2 MiB bound applies to this configuration document, not file transfers or remote directory trees.

Saving validates enabled installed adapters and their package revisions, refuses undeclared configuration keys and validates public field types. A profile remains loadable after adapter removal so it can be reviewed or removed. Failure to load the profile store is shown in the dialog while manual adapter connections remain available.

## Verification

Three native tests cover persistence of independent Files/Terminal sources, credential omission, revision conflicts, concurrent creates, unknown configuration, missing adapters, invalid roles and preservation of corrupt/future files. Frontend cases cover password reclassification, removed or mistyped fields, revision-bearing updates/removal and endpoint-specific host-key reviews. The 64-check Windows adapter fixture exercises save/reopen/update/remove through the actual dialog and native store, including a mixed SSH profile, secret omission and invalid SSH preparation preserving the existing workspace. A separate real loopback SSH test verifies binary console I/O after replacing an independent Files source. The desktop fixture uses synthetic adapter data; it does not establish a valid mixed SSH GUI connection or new protocol/platform support.
