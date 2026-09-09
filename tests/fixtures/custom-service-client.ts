// SPDX-License-Identifier: MPL-2.0
// Only the integration package adds this control channel to the public example.
import { connection } from "../../examples/service-inspector/main";
import type { RemoteConsole } from "@shellcanvas/app-sdk";
let retainedConsole: RemoteConsole | undefined;
window.addEventListener("message", async (event) => {
  if (event.source !== parent || event.data?.type !== "custom-service-probe")
    return;
  try {
    const client = await connection;
    let value: unknown;
    switch (event.data.action) {
      case "console": {
        const binding = (await client.environment.get()).binding!;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        const first = await client.console.open({ binding }, controller.signal);
        const second = await client.console.open(
          { binding, cols: 100, rows: 30 },
          controller.signal,
        );
        try {
          const expected = Uint8Array.from(
            { length: 150000 },
            (_, i) => i % 256,
          );
          const received: number[] = [];
          const reading = (async () => {
            while (received.length < expected.length) {
              const chunk = await first.read();
              if (!chunk) throw new Error("Early console EOF");
              received.push(...chunk);
            }
          })();
          await Promise.all([reading, first.write(expected)]);
          if (first.resizable) await first.resize(120, 40);
          await first.close();
          await second.write(new Uint8Array([0, 255, 10]));
          const survivor = await second.read();
          value = {
            bytes:
              received.length === expected.length &&
              received.every((byte, i) => byte === expected[i]),
            survivor: JSON.stringify([...survivor!]) === "[0,255,10]",
            resizable: first.resizable,
          };
          retainedConsole = await client.console.open({ binding });
        } finally {
          clearTimeout(timer);
          await first.close();
          await second.close();
        }
        break;
      }
      case "console-stale":
        await retainedConsole!.write("must not reach a replacement");
        break;
      case "text":
        value = await client.files.readText({
          binding: (await client.environment.get()).binding!,
          path: "fixture:note",
        });
        break;
      case "browse":
        for await (const page of client.files.list({
          binding: (await client.environment.get()).binding!,
        })) {
          value = page.entries;
          break;
        }
        break;
      case "browse-all": {
        let entries = 0,
          pages = 0;
        for await (const page of client.files.list({
          binding: (await client.environment.get()).binding!,
        })) {
          entries += page.entries.length;
          pages++;
        }
        value = { entries, pages };
        break;
      }
      case "browse-cancel": {
        const controller = new AbortController();
        const reader = client.files
          .list(
            { binding: (await client.environment.get()).binding! },
            controller.signal,
          )
          [Symbol.asyncIterator]();
        value = (await reader.next()).value.entries.length;
        controller.abort();
        await reader.return?.();
        break;
      }
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
