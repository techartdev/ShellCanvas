// SPDX-License-Identifier: MPL-2.0
import {
  FolderClosed,
  SquareTerminal,
  MonitorCog,
  FilePenLine,
} from "lucide-react";
import { defineApps } from "../sdk";
import { Files } from "./Files";
import { Terminal } from "./Terminal";
import { HostDetails } from "./HostDetails";
import { Editor } from "./Editor";
export const apps = defineApps([
  {
    apiVersion: 1,
    id: "editor",
    title: "Text editor",
    subtitle: "A quiet place for your remote files",
    scope: "host",
    requires: ["files.read"],
    optional: ["files.edit", "files.create"],
    icon: FilePenLine,
    component: Editor,
    window: { layout: "primary", multiple: true },
  },
  {
    apiVersion: 1,
    id: "files",
    title: "Files",
    subtitle: "Explore your remote filesystem",
    scope: "host",
    requires: ["files.read"],
    optional: [
      "files.manage",
      "files.move",
      "files.create",
      "files.upload",
      "files.download",
    ],
    icon: FolderClosed,
    component: Files,
    window: { layout: "primary", openOnStart: true, multiple: true },
  },
  {
    apiVersion: 1,
    id: "terminal",
    title: "Terminal",
    subtitle: "A direct line to your host",
    scope: "host",
    requires: ["terminal"],
    icon: SquareTerminal,
    component: Terminal,
    window: { layout: "secondary", openOnStart: true, multiple: true },
  },
  {
    apiVersion: 1,
    id: "host-details",
    title: "Host details",
    subtitle: "Your system and available workspace tools",
    scope: "host",
    requires: [],
    optional: ["host.settings"],
    icon: MonitorCog,
    component: HostDetails,
  },
]);
