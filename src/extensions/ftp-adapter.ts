// SPDX-License-Identifier: MPL-2.0
import type { RepositoryAdapterSource } from "../adapters";

/** The manifest hashes are pinned to the reviewed v0.1.0 repository tag. */
export const ftpAdapterSource: RepositoryAdapterSource = {
  owner: "techartdev",
  repository: "ShellCanvas-FTP",
  reference: "v0.1.0",
  id: "dev.shellcanvas.ftp",
  version: "0.1.0",
  packages: [
    {
      platform: "windows-x86_64",
      path: "dist/windows-x86_64/adapter.json",
      sha256:
        "74f1c81b25e4c93e54c73e1a53cf9ee403bb9917afe752240b206f12b9be1e89",
    },
    {
      platform: "linux-x86_64",
      path: "dist/linux-x86_64/adapter.json",
      sha256:
        "709f183f80367b9fc67b3e76d7182d4de0d31d2d9c1b0c9d8712017ac3af1d77",
    },
    {
      platform: "macos-x86_64",
      path: "dist/macos-x86_64/adapter.json",
      sha256:
        "34c6c43b15b1fd8f93b7272b9e86a8f02fed52085d5339c2e059a7be4a3a539f",
    },
    {
      platform: "macos-aarch64",
      path: "dist/macos-aarch64/adapter.json",
      sha256:
        "280ccd267a8129de232f7bd6c6e7e0299345e21611d38964f73959e7d1d26d5b",
    },
  ],
};
