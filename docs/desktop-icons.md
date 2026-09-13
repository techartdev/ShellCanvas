# Desktop icons

Shortcuts to apps and remote folders sit on the desktop itself, arranged the way
you leave them. Each host keeps its own desktop, so the machine you connect to
decides which icons appear.

## Adding a shortcut

- **An app.** Right-click its dock button and choose **Add to desktop**.
- **A folder.** In Files, right-click any folder and choose **Add to desktop**.

A shortcut that is already on the desktop is not added twice, and the desktop
reports when it has no free cell left rather than stacking icons.

## Using them

- **Double-click** an icon to open it. An app shortcut opens that app; a folder
  shortcut opens a Files window at that folder.
- **Drag** an icon to rearrange it. The icon snaps to the grid, and an occupied
  cell pushes it to the nearest free one instead of letting two icons overlap.
  Dragging is available at the same window width as the other move and resize
  affordances, 900 pixels.
- **Keyboard.** Tab reaches each icon; Enter or Space opens it; Ctrl and an
  arrow key moves it a cell; the Menu key or Shift+F10 opens its menu.
- **Right-click.** An icon offers **Open** and **Remove from desktop**. The
  empty desktop offers the desktop actions, including **Arrange desktop icons**,
  which re-tiles everything into reading order.

Windows cover icons, as they do on any desktop. **Show / restore desktop** from
the desktop menu clears them out of the way.

## Where the arrangement is kept

The layout is stored locally on this computer, filed under the identity of the
host the workspace is connected to. That identity is derived from the endpoint,
so reconnecting, renaming a saved host or replacing its key all keep the same
desktop, while a different host gets a different one. Workspaces with no
connection share a local desktop.

Because the layout is local, it does not travel to another computer, and nothing
is written to the remote host. The design preview keeps its own arrangement,
separate from any real host.

If the saved layout cannot be read — edited by hand into something invalid, or
written by a newer version — the desktop starts empty and says so rather than
discarding what is there. Adding an icon then replaces it.

## Limitations

- A folder shortcut stores the provider's own location. Renaming or moving that
  folder on the host does not update the shortcut, and opening it afterwards
  fails the way any stale location does.
- Shortcuts cannot be renamed, and there is no multiple selection.
- Icons cannot be dragged out of Files onto the desktop; use **Add to desktop**.
- A narrower desktop pulls icons back inside the grid, which can change an
  arrangement that no longer fits. Icons that still fit are left alone.
