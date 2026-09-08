// SPDX-License-Identifier: MPL-2.0
// Only the integration package adds this control channel to the public example.
import { connection } from "../../examples/service-inspector/main";
window.addEventListener("message", async (event) => {
  if (event.source !== parent || event.data?.type !== "custom-service-probe")
    return;
  try {
    const client = await connection;
    let value: unknown;
    switch (event.data.action) {
      case "list":
        value = await client.services.list();
        break;
      case "cancel": {
        const controller = new AbortController();
        const pending = client.services.call(
          "acme.wait",
          { ms: 3000, value: "late" },
          controller.signal,
        );
        // Poll the fixture's read-only counter to prove dispatch before cancellation.
        for (let attempt = 0; attempt < 30; attempt++) {
          if (Number(await client.services.call("acme.waitCount")) > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        controller.abort();
        value = await pending;
        break;
      }
      default:
        value = await client.services.call(
          event.data.method ?? "acme.echo",
          event.data.params ?? { message: "fixture", nested: [1, true, null] },
        );
    }
    parent.postMessage(
      { type: "custom-service-result", id: event.data.id, value },
      "*",
    );
  } catch (error) {
    parent.postMessage(
      {
        type: "custom-service-result",
        id: event.data.id,
        error: String(error),
        code: (error as { code?: string }).code,
      },
      "*",
    );
  }
});
