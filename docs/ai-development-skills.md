# AI-assisted extension development

The repository distributes three portable `SKILL.md` entrypoints for AI coding
tools:

| Skill                                                         | Use it for                                            |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| [shellcanvas-app](../skills/shellcanvas-app/SKILL.md)         | Public-SDK desktop apps and shared system services    |
| [shellcanvas-adapter](../skills/shellcanvas-adapter/SKILL.md) | Device/protocol implementations and service contracts |
| [shellcanvas-package](../skills/shellcanvas-package/SKILL.md) | Packaging, distribution, review and runtime lifecycle |

Point an AI coding tool at the relevant file, for example: "Use
`skills/shellcanvas-app/SKILL.md` to build my device-notes app." The files use
the standard name/description frontmatter, so a tool with skill installation
support can register them through its own workflow.

**The skills need no ShellCanvas checkout.** Both SDKs are published —
`@techartdev/shellcanvas-app-sdk` on npm and `shellcanvas-adapter-sdk` on
crates.io — and the skills reference the public documentation at
<https://shellcanvas.com/docs/> rather than repository paths, so they work from
an empty project directory in any editor. Cloning this repository changes no
machine-wide AI configuration.

The skills guide implementation decisions and point at the SDK command guides.
They are not replacements for the user's product requirements, permission
decisions or device-specific tests. A generated echo service proves
extensibility, not support for FTP, serial or another requested protocol. Actual
remote system support remains governed by its representative tests and
compatibility matrix.

These are development skills. They do not implement the optional in-desktop AI
assistant. The independent
[Canvas Assistant](https://github.com/techartdev/ShellCanvas-Assistant) supplies
its own operating skill under `skills/canvas-assistant/SKILL.md`; the assistant's
tool loop remains in its own repository.

## Validation

The documented commands were executed from fresh directories outside this
checkout, consuming only the published packages:

- `npm install --save-dev @techartdev/shellcanvas-app-sdk`, then `init`,
  `npm install`, `npm run build` and `validate` produced and accepted a starter
  package. The generated project depends on the registry release, so `--sdk` is
  needed only for a locally packed tarball.
- `cargo install shellcanvas-adapter-sdk` installed the `shellcanvas-adapter`
  CLI, and a separate project consuming `shellcanvas-adapter-sdk = "0.1.0"`
  compiled against the published crate.
- The adapter skill's example adapter compiles as written.

Two limits are recorded in the skills because they are easy to hit: invoking the
app CLI as `npx -p @techartdev/shellcanvas-app-sdk shellcanvas-app …` exits
without running, so the CLI must be installed locally and called through `npx
shellcanvas-app` or an npm script; and `shellcanvas-adapter init` requires
`--sdk-source`, which a developer without a checkout does not have, so the skill
describes writing the project against the published crate and packaging with
`pack` instead.

Earlier fixture evidence still applies to the generated starters: the app
starter passed eight Windows interaction checks for installation, shared
dialogs, saved text, local storage and dirty-close draft preservation, and the
generated adapter installation is covered by the retained 68-check Windows
adapter checkpoint. Those are synthetic fixture workflows, not real device
implementation tests or an independent AI-agent study.
