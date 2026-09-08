// SPDX-License-Identifier: MPL-2.0
import { useState } from "react";
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { previewServices, previewSession } from "../../src/preview";
import type { FileEntry, HostServices } from "../../src/sdk";
import "../../src/styles.css";
const entries: FileEntry[] = [
  {
    name: "file10.txt",
    path: "item@10",
    kind: "file",
    size: 100,
    modified: 20,
  },
  {
    name: "Projects",
    path: "folder@1",
    kind: "directory",
    size: 0,
    modified: 30,
  },
  { name: "file2.txt", path: "item@2", kind: "file", size: 300, modified: 10 },
  {
    name: ".hidden",
    path: "item@hidden",
    kind: "file",
    size: 50,
    modified: null,
  },
  {
    name: "unknown.txt",
    path: "item@unknown",
    kind: "file",
    size: 200,
    modified: null,
  },
];
function Fixture() {
  const [reads, setReads] = useState(0);
  const [backend] = useState<HostServices>(() => ({
    ...previewServices,
    list: async () => {
      setReads((value) => value + 1);
      return {
        path: "folder@root",
        name: "Sorting workspace",
        parent: null,
        home: null,
        roots: [],
        entries,
      };
    },
  }));
  return (
    <>
      <App
        services={backend}
        initialSession={{
          ...previewSession,
          info: {
            ...previewSession.info,
            hostname: "sorting-fixture",
            capabilities: ["files.read"],
          },
        }}
      />
      <output
        style={{
          position: "fixed",
          bottom: 3,
          left: 5,
          zIndex: 100,
          fontSize: 10,
        }}
      >
        Provider reads: {reads}
      </output>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
