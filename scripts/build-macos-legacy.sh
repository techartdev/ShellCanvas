#!/bin/sh
# SPDX-License-Identifier: MPL-2.0
set -eu
if [ "$(uname -s)" != Darwin ]; then
  printf '%s\n' 'This compatibility build is for macOS.' >&2
  exit 1
fi
cd "$(dirname "$0")/.."
# Keep the old 4 GB Intel test machine usable while compiling.
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}"
export CARGO_PROFILE_DEV_DEBUG=0
export CARGO_INCREMENTAL=0
# objc2 0.6.4 validates a WKNavigationDelegate method absent on Catalina.
# Scope this upstream workaround to objc2 in this explicit debug build only.
# https://github.com/tauri-apps/tauri/issues/15431
exec npm run tauri -- build --debug --no-bundle -- --locked \
  --config 'profile.dev.package.objc2.debug-assertions=false'
