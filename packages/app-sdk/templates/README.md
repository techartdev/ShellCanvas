# Your ShellCanvas app

Run `npm install`, then `npm run build`. In ShellCanvas, open **App Manager → Add apps → Choose package…**, choose `dist/app.shellcanvas.json`, review its permissions and open it. Rebuilding and installing an update does not require rebuilding or restarting the desktop. Existing windows keep their original package; close and reopen to use the new version.

Edit `main.ts`, `style.css` and `shellcanvas.json`. The SDK types and manifest schema are installed locally. This starter uses shared dialogs, local app storage, capability discovery, state events and dirty/busy window reporting. No framework is required. The browser preview can show synthetic host services; it cannot connect to remote hosts.

Treat file paths as opaque values. Picking a destination does not authorize overwriting it. Inspect method `granted` and `available` separately. Cancellation does not undo a dispatched write; do not automatically retry writes. Revision conflicts require reloading/reviewing the stored value, not blindly overwriting another window's changes.

Declare only permissions your app uses. Native adapters are separate executable packages; this UI app cannot use Node, native Tauri IPC, arbitrary networking or the user's local filesystem. Bundle all JavaScript and keep CSS in `style.css`; external assets and imports are unsupported. SDK version 0.1 is provisional and uses wire protocol v1.
