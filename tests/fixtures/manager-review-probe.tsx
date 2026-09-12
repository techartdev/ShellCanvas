// SPDX-License-Identifier: MPL-2.0
// Open with Vite at /tests/fixtures/manager-review-probe.html.
// Uses an in-memory catalog; never installs apps or contacts a remote host.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ExtensionManager } from "../../src/extensions/ExtensionManager";
import { AppCatalog, type InstallReview } from "../../src/extensions/catalog";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const container = document.querySelector<HTMLDivElement>("#root")!;
const result = document.querySelector<HTMLPreElement>("#result")!;
const root = createRoot(container);
const catalog = new AppCatalog(
  {
    read: async () => null,
    compareAndSet: async () => {
      throw new Error("Unexpected catalog write");
    },
  },
  async () => ({ platform: "windows" }),
);
const raw = JSON.stringify({
  format: 1,
  kind: "app",
  id: "org.example.review",
  version: "1.0.0",
  title: "Review fixture",
  permissions: [],
  script: "console.log('fixture')",
  style: "",
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function button(label: string) {
  const value = [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  check(value, `Missing button: ${label}`);
  return value;
}
async function click(label: string) {
  const target = button(label);
  check(!target.disabled, `Disabled button: ${label}`);
  await act(async () => target.click());
}
async function settle(action: () => void) {
  await act(async () => action());
}
const passed: string[] = [];
try {
  let read = deferred<string>();
  await act(async () =>
    root.render(
      <ExtensionManager catalog={catalog} sample={() => read.promise} />,
    ),
  );
  await click("Add apps");
  await click("Review built sample");
  await click("Installed");
  await settle(() => read.resolve(raw));
  check(
    !container.textContent?.includes("Package fingerprint"),
    "Late read reopened review",
  );
  passed.push("Navigation ignores a late file read");

  await click("Add apps");
  read = deferred<string>();
  const old = read;
  await click("Review built sample");
  await click("Installed");
  await click("Add apps");
  read = deferred<string>();
  await click("Review built sample");
  await settle(() => old.reject(new Error("Obsolete read failure")));
  check(
    !container.querySelector('[role="alert"]'),
    "Late error leaked into current page",
  );
  check(
    button("Review built sample").disabled,
    "Late completion cleared a newer busy state",
  );
  await settle(() => read.reject(new Error("Current read failure")));
  check(
    container.querySelector('[role="alert"]')?.textContent ===
      "Current read failure",
    "Current error was lost",
  );
  check(
    !button("Review built sample").disabled,
    "Current failure left busy state stuck",
  );
  passed.push(
    "Stale errors cannot replace current errors or clear a newer busy state",
  );

  const review = await catalog.review(raw);
  const pending = deferred<InstallReview>();
  catalog.review = () => pending.promise;
  read = deferred<string>();
  read.resolve(raw);
  await click("Review built sample");
  await click("Installed");
  await settle(() => pending.resolve(review));
  check(
    !container.textContent?.includes("Package fingerprint"),
    "Late catalog review reopened page",
  );
  passed.push("Navigation ignores a late catalog review");

  let visit = 0;
  read = deferred<string>();
  const render = () =>
    root.render(
      <ExtensionManager
        catalog={catalog}
        page="add"
        navigate={() => {}}
        visit={visit}
        sample={() => read.promise}
      />,
    );
  await act(async () => render());
  await click("Review built sample");
  await act(async () => {
    visit++;
    render();
  });
  await settle(() => read.resolve(raw));
  check(
    !container.textContent?.includes("Package fingerprint"),
    "Parent navigation reopened review",
  );
  check(
    !button("Review built sample").disabled,
    "Parent navigation left busy state stuck",
  );
  passed.push("Parent section navigation invalidates pending work");

  await click("Review built sample");
  check(
    container.textContent?.includes("Package fingerprint"),
    "Fresh review did not open",
  );
  check(!button("Install app").disabled, "Fresh review stayed busy");
  passed.push("Fresh review still opens after navigation");
  result.textContent = `PASS: ${passed.length} checks\n${passed.join("\n")}`;
} catch (error) {
  result.textContent = `FAIL: ${String(error)}\n${passed.join("\n")}`;
  throw error;
} finally {
  await act(async () => root.unmount());
}
