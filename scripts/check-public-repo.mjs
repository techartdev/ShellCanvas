// SPDX-License-Identifier: MPL-2.0
import { readFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, extname, resolve } from "node:path";

const repository = new URL("../", import.meta.url);
const root = decodeURIComponent(repository.pathname).replace(/^\/([A-Za-z]:)/, "$1");
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { cwd: root, encoding: "utf8" },
)
  .trim().split(/\r?\n/).filter(Boolean);
const forbidden = [
  /[A-Z]:\\(?:Users|Mine)\\/i,
  /49\.13\.19\.149/,
  new RegExp(`\\b${["evtin", "sait"].join("")}\\b`, "i"),
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:gh[opsu]_|npm_)[A-Za-z0-9_-]{20,}\b/,
];
const errors = [];
let markdownFiles = 0;
for (const file of files) {
  const path = resolve(root, file);
  const contents = await readFile(path);
  if (contents.includes(0)) continue;
  const source = contents.toString("utf8");
  for (const pattern of forbidden) if (pattern.test(source)) errors.push(`${file}: contains private release data matching ${pattern}`);
  if (extname(file).toLowerCase() !== ".md") continue;
  markdownFiles++;
  for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().replace(/^<|>$/g, "");
    if (!target || /^(?:https?:|mailto:|#)/i.test(target)) continue;
    const local = decodeURIComponent(target.split(/[?#]/, 1)[0]);
    const candidate = resolve(dirname(path), local);
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) await stat(resolve(candidate, "README.md"));
    } catch {
      errors.push(`${file}: missing local link target ${target}`);
    }
  }
}
if (errors.length) throw new Error(`Public repository check failed:\n${errors.join("\n")}`);
console.log(`Public repository check passed for ${files.length} text/binary files and ${markdownFiles} Markdown documents.`);
