// SPDX-License-Identifier: MPL-2.0
// Synthetic provider graph. The apps cannot derive relationships from its paths.
import { previewServices, previewSession } from "../../src/preview";
import type {
  Directory,
  FileEntry,
  FilePlace,
  HostServices,
  Session,
  TextDocument,
} from "../../src/sdk";
export type FileFixture = "unix" | "drives" | "virtual";
export function filesystemFixture(
  kind: FileFixture,
  log: (text: string) => void = () => {},
) {
  const locations = {
    unix: {
      root: "/",
      extra: "/mnt",
      home: "/home/demo",
      child: "/home/demo/Projects",
      file: "/home/demo/notes.txt",
      separator: "/",
    },
    drives: {
      root: "C:\\",
      extra: "D:\\",
      home: "C:\\Users\\Demo",
      child: "C:\\Users\\Demo\\Projects",
      file: "C:\\Users\\Demo\\notes.txt",
      separator: "\\",
    },
    virtual: {
      root: "volume@main",
      extra: "volume@archive",
      home: "node@workspace",
      child: "node@19%2Fopaque",
      file: "object@93?kind=text",
      separator: "",
    },
  }[kind];
  const roots: FilePlace[] = [
    {
      path: locations.root,
      name: kind === "drives" ? "System (C:)" : "Main volume",
    },
    {
      path: locations.extra,
      name: kind === "drives" ? "Data (D:)" : "Archive",
    },
  ];
  const home =
    kind === "virtual" ? null : { path: locations.home, name: "Home" };
  const entry = (
    path: string,
    name: string,
    kind: FileEntry["kind"],
  ): FileEntry => ({
    path,
    name,
    kind,
    size: 42,
    modified: null,
    revision: "1",
  });
  const folders = new Map<string, Directory>();
  for (const [path, name, parent, entries] of [
    [
      locations.root,
      roots[0].name,
      null,
      [entry(locations.home, "Workspace", "directory")],
    ],
    [locations.extra, roots[1].name, null, []],
    [
      locations.home,
      "Workspace",
      locations.root,
      [
        entry(locations.child, "Projects", "directory"),
        entry(locations.file, "notes.txt", "file"),
      ],
    ],
    [locations.child, "Projects", locations.home, []],
  ] as [string, string, string | null, FileEntry[]][])
    folders.set(path, { path, name, parent, entries, roots, home });
  const documents = new Map<string, TextDocument>([
    [
      locations.file,
      {
        path: locations.file,
        name: "notes.txt",
        parent: locations.home,
        text: "Provider-owned paths.\n",
        revision: "1",
        writable: true,
      },
    ],
  ]);
  let next = 1;
  const session: Session = {
    ...previewSession,
    id: 301,
    info: {
      ...previewSession.info,
      hostname: `fixture-${kind}`,
      provider: `fixture-${kind}`,
      system: "Synthetic file service",
      home: null,
      capabilities: ["files.read", "files.edit", "files.create", "files.move"],
    },
  };
  const backend: HostServices = {
    ...previewServices,
    list: async (_, path) => {
      log(`list ${path === undefined ? "<default>" : path}`);
      const directory = folders.get(path ?? locations.home);
      if (!directory) throw new Error(`Unknown fixture location: ${path}`);
      return structuredClone(directory);
    },
    readText: async (_, path) => {
      log(`read ${path}`);
      const doc = documents.get(path);
      if (!doc) throw new Error(`Unknown fixture file: ${path}`);
      return { ...doc };
    },
    preview: async (_, path) => documents.get(path)?.text ?? "No fixture text",
    moveEntry: async (_, path, parent, revision, tracked) => {
      const source = [...folders.values()].find((folder) =>
        folder.entries.some((item) => item.path === path),
      );
      const item = source?.entries.find((item) => item.path === path);
      const target = folders.get(parent);
      if (!source || !item || item.revision !== revision)
        throw new Error("CONFLICT: Fixture item changed");
      if (!target) throw new Error("Choose an existing provider folder.");
      if (item.kind !== "file")
        throw new Error("This synthetic provider only moves files.");
      if (target.entries.some((entry) => entry.name === item.name))
        throw new Error("This name already exists.");
      const destination =
        kind === "virtual"
          ? `moved@${next++}`
          : parent.replace(/[\\/]$/, "") + locations.separator + item.name;
      source.entries = source.entries.filter((entry) => entry.path !== path);
      target.entries.push({ ...item, path: destination });
      const doc = documents.get(path);
      if (doc) {
        documents.delete(path);
        documents.set(destination, { ...doc, path: destination, parent });
      }
      log(`move ${path} -> ${parent} :: ${destination}`);
      return {
        path: destination,
        locations: tracked
          .filter((previous) => previous === path)
          .map((previous) => ({
            previous,
            location: { path: destination, parent, name: item.name },
          })),
      };
    },
    createText: async (_, parent, name, text) => {
      const directory = folders.get(parent);
      if (!directory) throw new Error("Choose an existing provider folder.");
      if (
        kind !== "virtual" &&
        (name.includes(locations.separator) || [".", ".."].includes(name))
      )
        throw new Error("This provider requires one file name.");
      if (directory.entries.some((e) => e.name === name))
        throw new Error("This name already exists.");
      const path =
        kind === "virtual"
          ? `created@${next++}`
          : parent.replace(/[\\/]$/, "") + locations.separator + name;
      const doc = { path, name, parent, text, revision: "1", writable: true };
      documents.set(path, doc);
      directory.entries.push(entry(path, name, "file"));
      log(`create ${parent} :: ${name} -> ${path}`);
      return { ...doc };
    },
    saveText: async (_, path, text, revision) => {
      const doc = documents.get(path);
      if (!doc || doc.revision !== revision)
        throw new Error("CONFLICT: Fixture file changed");
      const saved = { ...doc, text, revision: String(Number(revision) + 1) };
      documents.set(path, saved);
      log(`save ${path}`);
      return { ...saved };
    },
  };
  return { session, backend, locations };
}
