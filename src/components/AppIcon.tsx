// SPDX-License-Identifier: MPL-2.0
import { useState, type ComponentType } from "react";
import { Blocks } from "lucide-react";
import "./AppIcon.css";

/** Shown for apps that do not package their own artwork. */
export const GenericAppIcon = Blocks;

type Glyph = ComponentType<{ size?: number; strokeWidth?: number }>;

/** Only bundled ids select theme identity colors; installed ids always contain a dot. */
function identity(id: string) {
  return /^[a-z][a-z-]*$/.test(id) ? id : "installed-app";
}

export function AppIcon({
  id,
  image,
  icon: Icon = GenericAppIcon,
  size,
  glyph,
}: {
  id: string;
  image?: string;
  icon?: Glyph;
  /** Omit to use the dock size. */
  size?: "launcher" | "tile" | "hero";
  glyph?: number;
}) {
  const [failed, setFailed] = useState<string>();
  const artwork = image && failed !== image ? image : undefined;
  return (
    <span
      className={`dock-app-icon app-icon ${identity(id)}${artwork ? " has-image" : ""}`}
      data-size={size}
      aria-hidden="true"
    >
      {artwork ? (
        <img
          src={artwork}
          alt=""
          draggable={false}
          onError={() => setFailed(artwork)}
        />
      ) : (
        <Icon size={glyph} />
      )}
    </span>
  );
}

/** A small image icon for window titles and other glyph-sized places. */
export function imageGlyph(image: string): Glyph {
  return function PackagedIcon({ size = 16 }) {
    const [failed, setFailed] = useState(false);
    return failed ? (
      <GenericAppIcon size={size} />
    ) : (
      <img
        className="app-icon-glyph"
        src={image}
        alt=""
        width={size}
        height={size}
        draggable={false}
        onError={() => setFailed(true)}
      />
    );
  };
}
