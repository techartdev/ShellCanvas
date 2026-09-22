// SPDX-License-Identifier: MPL-2.0
import { expect, it, vi } from "vitest";
import { installWithNativeDependency, resolveNativeDependency } from "./native-dependency";

const adapter = (digest: string, revision = "r1") => ({ id:"dev.example.db",name:"Database",version:"1.0.0",description:"",platform:"windows-x86_64",entrypoint:"bin/db.exe",configuration:[],generation:"g1",revision,enabled:true,fileCount:1,bytes:10,digest });
const reviewed = (digest: string, replaces = false) => ({requestId:"request",package:adapter(digest),replaces});
const app = (id:string,digest:string) => ({package:{id,title:id,version:"1.0.0",format:1,kind:"app",permissions:[],script:"",style:""},principal:"p",generation:"g",grants:[],enabled:true,nativeAdapter:{id:"dev.example.db",version:"1.0.0",digest}}) as any;

it("selects install, exact reuse, managed replacement and rejects shared conflicts",()=>{
  expect(resolveNativeDependency("app",reviewed("a".repeat(64)),[],[]).mode).toBe("install");
  expect(resolveNativeDependency("app",reviewed("a".repeat(64),true),[adapter("a".repeat(64))],[]).mode).toBe("reuse");
  expect(()=>resolveNativeDependency("app",reviewed("a".repeat(64),true),[{...adapter("a".repeat(64)),enabled:false}],[])).toThrow("disabled");
  expect(resolveNativeDependency("app",reviewed("b".repeat(64),true),[adapter("a".repeat(64))],[app("app","a".repeat(64))]).mode).toBe("replace");
  expect(()=>resolveNativeDependency("app",reviewed("b".repeat(64),true),[adapter("a".repeat(64))],[app("other","a".repeat(64))])).toThrow("different");
});

it("rolls back the exact app commit when native installation fails",async()=>{
  const installed=app("app","a".repeat(64));const review={replaces:null} as any;
  const catalog={install:vi.fn(async()=>installed),rollbackInstall:vi.fn(async()=>{})} as any;
  const adapters={installDependency:vi.fn(async()=>{throw new Error("tampered")})} as any;
  await expect(installWithNativeDependency(catalog,review,[],adapters,{review:reviewed("a".repeat(64)),mode:"install"})).rejects.toThrow("rolled back");
  expect(catalog.rollbackInstall).toHaveBeenCalledWith(installed,null);
});

it("commits the app and the reviewed native dependency together", async () => {
  const installed = app("app", "a".repeat(64));
  const catalog = {
    install: vi.fn(async () => installed),
    rollbackInstall: vi.fn(),
  } as any;
  const adapters = { installDependency: vi.fn(async () => adapter("a".repeat(64))) } as any;
  await expect(installWithNativeDependency(
    catalog,
    { replaces: null } as any,
    ["services.dev.example.db"],
    adapters,
    { review: reviewed("a".repeat(64)), mode: "install" },
  )).resolves.toBe(installed);
  expect(adapters.installDependency).toHaveBeenCalledWith("request", false);
  expect(catalog.rollbackInstall).not.toHaveBeenCalled();
});

it("reports a recoverable partial state when exact rollback is no longer safe", async () => {
  const installed = app("app", "a".repeat(64));
  const catalog = {
    install: vi.fn(async () => installed),
    rollbackInstall: vi.fn(async () => { throw new Error("app changed"); }),
  } as any;
  const adapters = {
    installDependency: vi.fn(async () => { throw new Error("native changed"); }),
  } as any;
  await expect(installWithNativeDependency(
    catalog,
    { replaces: null } as any,
    [],
    adapters,
    { review: reviewed("a".repeat(64)), mode: "install" },
  )).rejects.toThrow("Manage the app and adapter separately");
});
