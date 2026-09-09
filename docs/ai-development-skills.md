# AI-assisted extension development

The repository distributes three portable `SKILL.md` entrypoints:

| Skill                                                         | Use it for                                            |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| [shellcanvas-app](../skills/shellcanvas-app/SKILL.md)         | Public-SDK desktop apps and shared system services    |
| [shellcanvas-adapter](../skills/shellcanvas-adapter/SKILL.md) | Device/protocol implementations and service contracts |
| [shellcanvas-package](../skills/shellcanvas-package/SKILL.md) | Packaging, review, updates and runtime lifecycle      |

Point an AI coding tool at the relevant file in a ShellCanvas checkout, for
example: “Use `skills/shellcanvas-app/SKILL.md` to build my device-notes app.”
The files use the standard name/description frontmatter. Their relative links
refer to maintained repository documentation; keep that checkout available when
using them. No machine-wide AI configuration is changed by cloning the repository.
Tools with skill installation support can register these paths using their own
installation workflow.

The skills guide implementation decisions and reference the SDK command guides.
They are not replacements for the user's product requirements, permission
decisions or device-specific tests. A generated echo service proves extensibility,
not support for FTP, serial or another requested protocol. Actual remote system
support remains governed by its representative tests and compatibility matrix.

These are development skills. They do not implement the optional in-desktop AI
assistant or integrate WispCrew.

## Validation

All three entrypoints pass the skill-creator validator, and their linked files
exist. Their SDK commands were followed using fresh projects outside the checkout:
the app tarball produced buildable/validated starter and lifecycle packages; the
adapter archive produced a CLI, generated project and validated native package.
Both adapter executables passed production-host process tests. The exported
schemas accepted the artifacts and rejected invalid fields/defaults.

The generated app passed eight Windows interaction checks for installation,
shared message/Open/Save dialogs, saved text, local storage and dirty-close/draft
preservation. The generated adapter installation is covered by the 68-check
Windows adapter fixture, including custom-service-only connection, actual service
calls and connection survival after package removal. These are synthetic fixture
workflows, not real device implementation tests or an independent AI-agent study.
