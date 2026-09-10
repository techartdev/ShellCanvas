# Theme and appearance milestone

Scope: a small, installable theme contract, user appearance controls, and one
coordinated light/dark design. This does not reopen the base API or assistant
milestones.

- [x] Versioned JSON package, namespaced identity, optional light/dark variants,
      validated semantic colors and bounded desktop styling. Partial variants inherit
      from Canvas; unsupported properties fail clearly.
- [x] Canvas daytime/evening design across desktop chrome, bundled applications,
      menus, file dialogs and Settings. Contrast checks for the built-in palette.
- [x] Install/review/replace/remove local files; GitHub single-file installation
      through the existing bounded native downloader. Built-in recovery theme.
- [x] Persistent selection and light/dark/system mode. Existing settings migrate;
      unreadable collections are preserved and failed writes do not claim success.
- [x] Local raster wallpaper import, normalization, storage, fill/fit/tile and
      removal; original photo files remain untouched.
- [x] Interface scale, toolbar height and dock size; theme-default reset and
      keyboard appearance recovery. Theme changes retain open shells and documents.
- [x] Authoring guide, schema and installable complete example.
- [x] Unit checks: parser, style limits, variant fallback, persistence, storage
      errors, corruption recovery, preference migration and palette contrast.
- [x] Browser preview: light/dark/system, install/reload/remove, photo/reload/remove,
      four scales (80/100/125/150), maximum bar sizes, window maximize/restore/drag,
      compact Settings and context menus; no JavaScript errors.
- [x] Final Windows embedded-assets build and native smoke test.

Validation on 2026-09-10: 280 frontend tests across 49 files, TypeScript and Vite
production build, and Windows debug build passed. The native WebView installed
the complete Canvas Study package, rendered a normalized local wallpaper under
the packaged CSP, removed the fixture photo, changed scale and recovered with
the keyboard shortcut. Original appearance preferences were restored. The final
executable (35,401,216 bytes, built 03:55 local time) passed a fresh native UI
smoke check and was reopened without the temporary inspection port.

The workspace fixture retained unsaved editor text and existing shells during
theme, scale and recovery changes, with no additional lifecycle/mutation events.
Fresh windows also fit a 970×540 viewport at 150% with maximum bar sizes; the
enlarged dock remains clickable above secondary status controls. Formatting and
`git diff --check` passed. GitHub transport reuses the existing tested bounded
repository reader; this milestone's live installation evidence is local files,
not a newly published public theme repository.

Follow-ups: isolated-app content theme propagation, additional wallpaper art and
icon packages, authenticated/private theme repositories, curated/signed catalog,
automated updates, physical Mac/Linux/mobile appearance acceptance. Those are not
hidden prerequisites for format 1. Browser checks do not establish native Mac
acceptance.
