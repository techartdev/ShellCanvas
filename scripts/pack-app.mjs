// SPDX-License-Identifier: MPL-2.0
// Compatibility entry point. The same packer ships with the standalone SDK.
import { main } from "../packages/app-sdk/bin/shellcanvas-app.mjs";
await main([
  "build",
  ...(process.argv.slice(2).length
    ? process.argv.slice(2)
    : ["examples/dialog-app"]),
]);
