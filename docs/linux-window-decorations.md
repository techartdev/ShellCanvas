# GNOME Wayland window decorations

Issue [#27](https://github.com/techartdev/ShellCanvas/issues/27) contains two separate problems. The pinned Tao revision restores normal GTK decoration handling on Wayland, including native button behavior. The remaining gray header and plain close button come from GTK 3's stock Adwaita styling.

ShellCanvas uses GTK 3 through Tauri/Tao on Linux. On GNOME, Mutter's X11 frame helper creates a GTK 4 header and loads libadwaita. The same application therefore gets different decoration styling when launched with the Wayland and X11 backends. Changing ShellCanvas's Appearance setting affects its web content, not the native toolkit's title-bar style.

Sources: [Mutter frame initialization](https://github.com/GNOME/mutter/blob/main/src/frames/main.c), [Mutter header creation](https://github.com/GNOME/mutter/blob/main/src/frames/meta-frame-header.c), [GTK 3 window CSS nodes](https://docs.gtk.org/gtk3/class.Window.html#css-nodes).

## Compatibility styling

`src-tauri/src/linux_decorations.rs` installs a small GTK CSS provider for the main window, only when the actual GDK display is Wayland and `XDG_CURRENT_DESKTOP` contains the `GNOME` token. It activates only for the stock `Adwaita` or `Adwaita-dark` theme, and respects an explicit `GTK_THEME` override by not activating.

The stylesheet supplies a flat light/dark header and circular window buttons. It does not replace the title-bar widget, intercept input, choose a button layout, change application theme preferences, or force X11. GTK still handles dragging, resizing, maximizing and close requests. Windows and macOS do not compile this integration.

GTK settings notifications update the dark variant and remove the styling if the user switches to a different theme, including HighContrast. The CSS applies only below the main window's own class and uses application priority, below user CSS. Settings handlers and the provider are removed when the window is destroyed.

This is a GTK 3 visual compatibility layer, not a migration to GTK 4 or a promise of pixel-identical decorations across GNOME releases.

## Validation

The `Verify GNOME Wayland decorations` workflow compiles the desktop's Linux test target and runs a native GTK test under a headless Weston Wayland compositor. It checks the actual header colors before/after, dark-mode changes, high-contrast opt-out, native button-layout changes and delivery of the close request to an application close guard. It captures header images as a CI artifact. The scope test also covers X11, other desktops, custom themes and an explicit theme override.

[The initial CI run](https://github.com/techartdev/ShellCanvas/actions/runs/36354108473) passed both tests, and its before/light/dark header images were inspected. The headless compositor captures unfocused headers. [The existing Linux and macOS native app-frame checks](https://github.com/techartdev/ShellCanvas/actions/runs/36354108344) also passed with this integration.

Run the native regression inside a Wayland session with `XDG_CURRENT_DESKTOP=GNOME`, no `GTK_THEME` override and a writable `SC_DECORATION_SNAPSHOTS` directory:

```sh
cargo test -p shellcanvas --lib linux_decorations --locked -- --include-ignored --test-threads=1
```

Before closing #27, ask the reporter to compare on Fedora 44 / GNOME 50: Follow system with a light and dark system preference, focused/unfocused windows, maximize/restore, and close. Weston validation exercises the real GTK Wayland path but cannot certify the exact rendering of that Fedora/GNOME installation.
