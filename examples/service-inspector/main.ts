// SPDX-License-Identifier: MPL-2.0
import { connectToShellCanvas } from "@shellcanvas/app-sdk";

document.body.innerHTML = `<main>
  <header><span class="eyebrow">DEVICE WORKSPACE</span><h1>Device Services</h1>
    <p>Explore the tools offered by your current connection.</p></header>
  <section><div class="heading"><h2>Available methods</h2><button id="refresh" disabled>Refresh</button></div>
    <ul aria-label="Services"></ul></section>
  <section><h2>Practice connection</h2><p>The sample adapter can echo a message back. This action uses its <code>acme</code> service.</p>
    <form><label>Message<input name="message" value="Hello from ShellCanvas" maxlength="1000"></label>
    <button id="send" disabled>Send message</button></form></section>
  <output role="status">Connecting to the desktop…</output>
</main>`;
const status = document.querySelector("output")!;
const refresh = document.querySelector<HTMLButtonElement>("#refresh")!;
const send = document.querySelector<HTMLButtonElement>("#send")!;
export const connection = connectToShellCanvas();
void connection
  .then((client) => {
    const discover = async () => {
      try {
        const methods = (await client.services.list()).filter(
          (item) => item.source,
        );
        document.querySelector("ul")!.replaceChildren(
          ...methods.map((method) => {
            const row = document.createElement("li");
            const name = document.createElement("code");
            name.textContent = method.name;
            const detail = document.createElement("span");
            detail.textContent = !method.available
              ? "Unavailable"
              : !method.granted
                ? "Access not approved"
                : `Version ${method.version}`;
            row.append(name, detail);
            return row;
          }),
        );
        const echo = methods.find((method) => method.name === "acme.echo");
        send.disabled = !echo?.available || !echo.granted;
        status.textContent = methods.length
          ? "Services belong to this window’s accepted connection."
          : "This connection offers no additional services.";
      } catch (error) {
        send.disabled = true;
        status.textContent = String(error);
      }
    };
    refresh.disabled = false;
    refresh.onclick = () => void discover();
    document.querySelector("form")!.onsubmit = (event) => {
      event.preventDefault();
      send.disabled = true;
      void client.services
        .call("acme.echo", {
          message: document.querySelector<HTMLInputElement>(
            'input[name="message"]',
          )!.value,
        })
        .then((result) => {
          status.textContent = JSON.stringify(result);
        })
        .catch((error) => {
          status.textContent = String(error);
        })
        .finally(() => {
          send.disabled = false;
        });
    };
    void discover();
  })
  .catch((error) => {
    status.textContent = String(error);
  });
