// SPDX-License-Identifier: MPL-2.0
import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FolderClosed } from "lucide-react";
import { AppIcon, imageGlyph } from "./AppIcon";

const image = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"/>')}`;

it("shows packaged artwork, or the generic glyph when an app has none", () => {
  const painted = renderToStaticMarkup(
    <AppIcon id="org.example.notes" image={image} size="tile" />,
  );
  expect(painted).toContain(
    'class="dock-app-icon app-icon installed-app has-image"',
  );
  expect(painted).toContain(`src="${image}"`);
  expect(painted).toContain('data-size="tile"');
  expect(painted).toContain('aria-hidden="true"');
  const generic = renderToStaticMarkup(<AppIcon id="org.example.notes" />);
  expect(generic).not.toContain("<img");
  expect(generic).toContain("lucide-blocks");
});

it("keeps theme identity classes for bundled apps only", () => {
  const files = renderToStaticMarkup(
    <AppIcon id="files" icon={FolderClosed} glyph={25} />,
  );
  expect(files).toContain('class="dock-app-icon app-icon files"');
  expect(files).toContain("lucide-folder-closed");
  expect(files).not.toContain("data-size");
  // An installed id cannot borrow a bundled app's colors.
  expect(renderToStaticMarkup(<AppIcon id="files.evil" />)).toContain(
    "installed-app",
  );
});

it("renders packaged artwork at glyph size for window titles", () => {
  const Glyph = imageGlyph(image);
  const markup = renderToStaticMarkup(<Glyph size={16} />);
  expect(markup).toContain('class="app-icon-glyph"');
  expect(markup).toContain('width="16"');
});
