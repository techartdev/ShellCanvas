// SPDX-License-Identifier: MPL-2.0
import { FolderClosed, SquareTerminal, MonitorCog } from "lucide-react";
import { defineApps } from "../sdk";
import { Files } from "./Files";
import { Terminal } from "./Terminal";
import { HostDetails } from "./HostDetails";
export const apps = defineApps([
  {
    apiVersion: 1,
    id: "files",
    title: "Files",
    subtitle: "Explore your remote filesystem",
    scope: "host",
    requires: ["files.read"],
    icon: FolderClosed,
    component: Files,
    window: { layout: "primary", openOnStart: true },
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
    window: { layout: "secondary", openOnStart: true },
  },
  {
    apiVersion: 1,
    id: "host-details",
    title: "Host details",
    subtitle: "Your system and available workspace tools",
    scope: "host",
    requires: [],
    icon: MonitorCog,
    component: HostDetails,
  },
]);
