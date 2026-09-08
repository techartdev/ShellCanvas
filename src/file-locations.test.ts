// SPDX-License-Identifier: MPL-2.0
import { expect, it } from "vitest";
import { bindSession } from "./session-services";
import { filesystemFixture } from "../tests/fixtures/filesystem-provider";

it.each(["unix", "drives", "virtual"] as const)(
  "passes %s navigation and text locations unchanged across a session binding",
  async (kind) => {
    const events: string[] = [];
    const { backend, session, locations } = filesystemFixture(kind, (text) =>
      events.push(text),
    );
    const { services } = bindSession(backend, session);
    const start = await services.list();
    expect(events[0]).toBe("list <default>");
    expect(start.path).toBe(locations.home);
    const child = await services.list(
      start.entries.find((e) => e.kind === "directory")!.path,
    );
    expect(child.path).toBe(locations.child);
    expect((await services.list(child.parent!)).path).toBe(start.path);
    for (const root of start.roots)
      expect((await services.list(root.path)).parent).toBeNull();
    const doc = await services.readText(locations.file);
    const copy = await services.createText(doc.parent!, "copy.txt", doc.text);
    expect(copy.parent).toBe(start.path);
    expect(copy.name).toBe("copy.txt");
    expect((await services.readText(copy.path)).text).toBe(doc.text);
    const entry = (await services.list()).entries.find(
      (item) => item.path === locations.file,
    )!;
    const moved = await services.moveEntry(
      entry.path,
      child.path,
      entry.revision!,
    );
    expect(
      (await services.list()).entries.some((item) => item.path === entry.path),
    ).toBe(false);
    expect(
      (await services.list(child.path)).entries.find(
        (item) => item.path === moved,
      )?.name,
    ).toBe("notes.txt");
    expect((await services.readText(moved)).text).toBe(doc.text);
    expect(events).toContain(
      `move ${locations.file} -> ${locations.child} :: ${moved}`,
    );
    await expect(services.list("invented/location")).rejects.toThrow(
      "Unknown fixture location",
    );
  },
);
