#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
import { build } from "esbuild";
import { readFile, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import {
  APP_ICON_MAX_BYTES,
  appIconTypes,
  parseAppManifest,
  parseAppPackage,
  validAppIcon,
} from "../dist/package.js";
import { parseAppRepository, validRepositoryPath } from "../dist/repository.js";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function repositoryManifest(directory, { path = "dist/app.shellcanvas.json", description } = {}) {
  if (!validRepositoryPath(path)) throw new Error("Package path must stay inside the repository.");
  directory = resolve(directory);
  const bytes = await readFile(join(directory, path));
  const app = parseAppPackage(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  const manifest = parseAppRepository(JSON.stringify({
    format: 1, kind: "app-repository", id: app.id, version: app.version, title: app.title,
    description: description ?? app.description ?? "",
    package: { path, sha256: createHash("sha256").update(bytes).digest("hex") },
  }));
  const destination = join(directory, "shellcanvas.repo.json");
  const temporary = join(directory, `.repository-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
  return destination;
}

/** Embed the manifest's icon file as a data URI, checking size and image type. */
async function embeddedIcon(directory, path) {
  const bytes = await readFile(join(directory, path));
  if (bytes.length > APP_ICON_MAX_BYTES)
    throw new Error(`${path} is larger than ${APP_ICON_MAX_BYTES / 1024} KiB.`);
  const type = appIconTypes[path.slice(path.lastIndexOf(".") + 1)];
  const icon = `data:${type};base64,${bytes.toString("base64")}`;
  if (!validAppIcon(icon))
    throw new Error(`${path} is not a valid ${type.slice(6).toUpperCase()} image.`);
  return icon;
}

export async function packApp(directory, version) {
  directory = resolve(directory);
  let manifest = parseAppManifest(
    await readFile(join(directory, "shellcanvas.json"), "utf8"),
  );
  if (version !== undefined)
    manifest = parseAppManifest(JSON.stringify({ ...manifest, version }));
  const icon =
    manifest.icon === undefined
      ? undefined
      : await embeddedIcon(directory, manifest.icon);
  const result = await build({
    entryPoints: [join(directory, "main.ts")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    metafile: true,
    logLevel: "silent",
  });
  if (
    result.outputFiles.length !== 1 ||
    Object.values(result.metafile.outputs).some(
      (output) => output.imports.length,
    )
  )
    throw new Error(
      "Apps must bundle their code and keep CSS in style.css; external assets/imports are unsupported.",
    );
  const artifact = JSON.stringify({
    ...manifest,
    ...(icon === undefined ? {} : { icon }),
    script: result.outputFiles[0].text,
    style: await readFile(join(directory, "style.css"), "utf8"),
  });
  parseAppPackage(artifact);
  const output = join(directory, "dist");
  await mkdir(output, { recursive: true });
  const destination = join(output, "app.shellcanvas.json");
  const temporary = join(output, `.package-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, artifact, { encoding: "utf8", flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return destination;
}

export async function createApp(directory, { id, title, description, sdk }) {
  directory = resolve(directory);
  const manifest = parseAppManifest(
    JSON.stringify({
      format: 1,
      kind: "app",
      id,
      title,
      ...(description === undefined ? {} : { description }),
      version: "0.1.0",
      permissions: [
        "system.dialogs",
        "system.storage",
        "files.read",
        "files.create",
      ],
    }),
  );
  // Local tarballs are explicit until the SDK is published. Resolve against the caller,
  // not against the newly created project. Never overwrite an existing directory.
  let dependency = "0.1.0";
  if (sdk) {
    const path = resolve(sdk);
    if (!path.endsWith(".tgz"))
      throw new Error("--sdk must name a packed SDK .tgz file.");
    await readFile(path);
    dependency = `file:${path.replaceAll("\\", "/")}`;
  }
  await mkdir(directory, { recursive: false });
  const main = (
    await readFile(join(packageRoot, "templates/main.ts"), "utf8")
  ).replace("__APP_TITLE__", JSON.stringify(title));
  const files = {
    "package.json":
      JSON.stringify(
        {
          name: id,
          version: "0.1.0",
          private: true,
          type: "module",
          scripts: {
            check: "tsc --noEmit",
            build: "npm run check && shellcanvas-app build .",
          },
          devDependencies: {
            "@techartdev/shellcanvas-app-sdk": dependency,
            typescript: "5.8.3",
          },
        },
        null,
        2,
      ) + "\n",
    "shellcanvas.json":
      JSON.stringify(
        {
          $schema:
            "./node_modules/@techartdev/shellcanvas-app-sdk/schemas/app-manifest.schema.json",
          ...manifest,
        },
        null,
        2,
      ) + "\n",
    "tsconfig.json":
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "ESNext",
            moduleResolution: "Bundler",
            lib: ["ES2022", "DOM", "DOM.Iterable"],
            strict: true,
            noEmit: true,
            skipLibCheck: true,
          },
          include: ["main.ts"],
        },
        null,
        2,
      ) + "\n",
    "main.ts": main,
    "style.css": await readFile(
      join(packageRoot, "templates/style.css"),
      "utf8",
    ),
    "README.md": await readFile(
      join(packageRoot, "templates/README.md"),
      "utf8",
    ),
    ".gitignore": "node_modules/\ndist/\n*.tsbuildinfo\n",
  };
  for (const [name, contents] of Object.entries(files))
    await writeFile(join(directory, name), contents, { flag: "wx" });
  return directory;
}

const help = `ShellCanvas app tools
  shellcanvas-app init <new-directory> --id org.example.notes --title "Notes" [--description "Quick notes"] [--sdk <sdk.tgz>]
  shellcanvas-app build [directory] [--version 0.2.0]
  shellcanvas-app validate <app.shellcanvas.json>
  shellcanvas-app repository [directory] [--path dist/app.shellcanvas.json] [--description "App description"]
Manifest "icon" names a PNG, JPEG, WebP or SVG file (at most 256 KiB) that build embeds.
The repository description defaults to the package description.
Install the generated project's dependencies, then run npm run build. No desktop rebuild is needed.`;
export async function main(args) {
  if (!args.length || ["--help", "-h"].includes(args[0])) {
    console.log(help);
    return;
  }
  const [command, ...rest] = args;
  const positionals = [],
    options = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (
      !(
        { init: ["id", "title", "description", "sdk"], build: ["version"], validate: [], repository: ["path", "description"] }[
          command
        ] ?? []
      ).includes(key) ||
      key in options ||
      !rest[i + 1] ||
      rest[i + 1].startsWith("--")
    )
      throw new Error(`Unknown, repeated or incomplete option: ${arg}`);
    options[key] = rest[++i];
  }
  if (positionals.length > 1)
    throw new Error("Provide one project directory or package file.");
  if (command === "init" && positionals.length && options.id && options.title)
    console.log(
      `Created ${await createApp(positionals[0], options)}. Run npm install and npm run build there.`,
    );
  else if (command === "build")
    console.log(
      `App package: ${await packApp(positionals[0] ?? ".", options.version)}`,
    );
  else if (command === "repository") console.log(`Repository manifest: ${await repositoryManifest(positionals[0] ?? ".", options)}`);
  else if (command === "validate" && positionals.length) {
    const app = parseAppPackage(
      await readFile(resolve(positionals[0]), "utf8"),
    );
    console.log(`Valid app package: ${app.id} ${app.version}`);
  } else throw new Error(help);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
