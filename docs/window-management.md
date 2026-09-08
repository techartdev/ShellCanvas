# Window controls

Every window has a visible actions menu in its titlebar. It includes creation (for apps that support multiple instances), minimize, maximize/restore, keyboard move/resize, left/right tiling and close. Closing continues to respect unsaved-work and running-operation guards.

On desktop layouts (900 CSS pixels or wider):

- **Tile left/right** fills one half of the work area between the top toolbar and bottom dock. Restore returns to the previous floating rectangle. Tiling follows viewport size without restarting the app or terminal.
- **Move with keyboard / Resize with keyboard** focuses the titlebar. Arrow keys move an edge by 16 pixels; Shift+arrow uses one pixel. Enter or Done accepts the result; Escape restores the starting rectangle, constrained to the current work area.
- **F6 / Shift+F6** while a titlebar or its controls are focused cycles between visible windows in creation order. Minimized windows and other workspaces are skipped. These keys are not intercepted in terminal/editor content.
- **Shift+F10** on a titlebar or its controls opens its actions menu. The titlebar is reachable with Tab. Mouse dragging, double-click maximize/restore and the native bottom-right resize corner remain available.

Narrower layouts use stacked, scrollable windows. Move, resize, tiling and maximize controls are disabled there. Returning to desktop width restores the arrangement. Layouts remain in memory while windows are mounted, including workspace switches; restarting the app does not restore window layout.

## Verification

Browser walkthrough: keyboard move and Escape restored the original rectangle; resize applied both 16-pixel and one-pixel changes; right-anchored Terminal resizing kept its left edge stationary. Repeated moves stopped at the work-area edges. F6 and Shift+F6 moved focus between Files and Terminal. At 1280×720, tiled windows occupied x=0–640 and x=640–1280, y=44–638, exactly between toolbar and dock. At 1000×650 both halves followed the available area. At 768×1024, windows stacked and desktop-only menu actions were disabled. Restore retained the prior floating size and position.

Native keyboard checks, drag-to-edge snap previews, touch resize handles and persistence across process restarts remain separate work.
