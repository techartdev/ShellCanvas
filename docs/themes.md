# Themes and appearance

Open **Desktop settings → Desktop**. Choose a theme and **Light**, **Dark**, or
**Follow system**. Canvas, the built-in theme, uses neutral white and charcoal
surfaces with blue accents, inspired by macOS and Windows 11. Changes apply to
open windows, menus, shared dialogs, the editor and the terminal without
reconnecting hosts.

The same page controls the wallpaper, interface scale (80–150%), top toolbar
height and dock icon size. Scaling changes text, controls and spacing through
layout units; it does not stretch a screenshot of the desktop. Maximized windows
use the space between the toolbar and dock. Terminal and editor font preferences
are their sizes at 100% interface scale.

Choose **Theme landscape**, an existing landscape, or **Choose a photo**. Local
PNG/JPEG/WebP images up to 20 MB are decoded and stored as a PNG, with the longest
side reduced to at most 3840 pixels. Images above 80 megapixels are rejected.
Choose fill, fit or tile. The photo stays on this device; it is not sent to a host
or theme publisher. Removing it deletes the stored copy, never the original file.

Switching themes preserves your size and wallpaper overrides. **Use theme
wallpaper and default sizes** clears those overrides. **Restore defaults** in the
Settings footer also resets the other desktop preferences, after confirmation.
It does not uninstall themes, delete a saved photo, close windows or delete hosts.

If a custom theme becomes hard to read, focus the desktop and press
**Ctrl+Alt+Shift+R** (Mac: **Command+Option+Shift+R**) to return to Canvas dark,
100% scale, its landscape and default bar sizes. This keeps terminal/editor/file
preferences and your installed themes. The shortcut is handled by the desktop;
an isolated app with keyboard focus does not forward its keystrokes to the shell.

## Install and share

Use **Install theme file**, select a JSON file, review its name/author/version,
then **Install and apply**. A theme with the same ID replaces the installed
version only through that review. **Remove theme** returns to Canvas. Canvas
itself cannot be removed or replaced.

Alternatively, put the file at the root of a GitHub repository as
`shellcanvas.theme.json`. In the desktop app, expand **Install from GitHub**,
enter `owner/repository` and a branch, tag or commit, then review and install.
Only that bounded JSON file is downloaded from GitHub's raw-content host. No
repository code executes. A commit reference provides a stable source; a branch
can change. Installation does not establish publisher identity or auto-update.
Private repositories needing authentication and a theme marketplace are outside
this first version. File installation also works in the browser design preview.

## Create a theme

Copy [Canvas Study](../examples/themes/canvas-study/shellcanvas.theme.json) into
your own repository and edit it. No SDK, compiler, CSS loader or native plugin is
needed. The [JSON schema](schemas/theme.schema.json) documents format 1. Associate
it with the file in your editor; `$schema` is not a theme-package field.

This is a complete, minimal theme:

```json
{
  "format": 1,
  "kind": "shellcanvas-theme",
  "id": "your-studio.ink",
  "version": "1.0.0",
  "name": "Ink",
  "author": "Your name",
  "variants": {
    "light": {
      "colors": { "accent": "#754077" },
      "windowRadius": 6,
      "font": "humanist"
    },
    "dark": {
      "colors": { "accent": "#d9afe0" },
      "windowRadius": 6,
      "font": "humanist"
    }
  }
}
```

Use your own namespaced ID. At least one variant is required; supplying both is
recommended. Missing properties inherit from the corresponding Canvas variant.
A theme with just one variant uses it for every color-mode choice, including
Follow system. Unknown fields are rejected so typos do not silently do nothing.

Each variant accepts `colors` and these optional values. Lengths are logical
pixels at 100% scale, except blur, which remains in CSS pixels.

| Property        | Values                                                        |
| --------------- | ------------------------------------------------------------- |
| `windowRadius`  | Integer 0–24                                                  |
| `windowHeader`  | Integer 32–60                                                 |
| `dockRadius`    | Integer 0–28                                                  |
| `blur`          | Integer 0–40, for the translucent dock                        |
| `toolbarHeight` | Integer 36–64                                                 |
| `dockSize`      | Integer 32–64                                                 |
| `font`          | `system`, `humanist`, `serif`, `mono` (local fallback stacks) |

Colors are opaque six-digit hex values. The desktop derives translucent shadows,
dock surfaces and icon fills itself.

| Colors                                                      | Purpose                                           |
| ----------------------------------------------------------- | ------------------------------------------------- |
| `base`, `surface`, `raised`, `inset`                        | Desktop backing, content, chrome, recessed panels |
| `text`, `muted`                                             | Primary and secondary text                        |
| `accent`, `onAccent`                                        | Actions/focus and text over solid accent buttons  |
| `border`, `hover`, `selection`                              | Separators and interaction states                 |
| `danger`, `dangerSoft`, `warning`, `warningSoft`, `success` | Status text and tinted message surfaces           |
| `shadow`, `scrim`                                           | Window shadows and modal backdrops                |
| `terminal`, `terminalText`                                  | Terminal canvas and default text                  |
| `sky`, `glow`, `far`, `mid`, `near`                         | Five colors of the theme's procedural landscape   |

Test text contrast against all four surfaces, selected rows, error states and
accent buttons. Canvas's normal/muted/action/status text against its three main
surfaces is checked at a minimum 4.5:1. Custom themes remain responsible for their
own contrast. Terminal programs can emit their own ANSI/true colors; the desktop
does not rewrite their output. App identity icons retain their artwork.

## Contract and storage boundaries

Themes are data, with a 32 KB UTF-8 file limit and up to 24 installed themes.
They contain no arbitrary CSS, selectors, JavaScript, external fonts, image URLs
or remote permissions. They style the shared desktop and bundled apps. Installed
apps keep their own isolated content styles; their window chrome and shared
system dialogs follow the desktop. Theme propagation inside isolated apps, icon
packs, additional wallpaper artwork formats, custom desktop layouts and signed
catalogs are future extensions rather than requirements for theme authors today.

Validated theme packages live in `shellcanvas.themes` in local WebView storage.
Preferences remain in the existing versioned `shellcanvas.preferences` record;
old wallpaper and app settings migrate without losing their values. A local
photo is a separate IndexedDB Blob in `shellcanvas-wallpaper`, avoiding the text
storage quota. Native and browser-preview stores are independent.

Unreadable/future theme collections are preserved and Canvas remains usable.
Settings offers an explicit collection reset. A failed collection write leaves
the previous installed collection intact and reports the error. A missing selected
theme falls back to Canvas. Preference storage has its existing error/recovery
behavior. Nothing here modifies host profiles, credentials or files on a host.
