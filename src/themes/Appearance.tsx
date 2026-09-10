// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, Download, ImagePlus, Moon, Sun, Trash2 } from "lucide-react";
import { usePreferences } from "../preferences";
import {
  canvasTheme,
  parseTheme,
  resolveTheme,
  themeLimit,
  type CanvasTheme,
} from "./model";
import { useThemes } from "./store";
import { useTheme } from "./runtime";
import { prepareWallpaper, readWallpaper, saveWallpaper } from "./wallpaper";
import {
  parseRepositoryLocation,
  readRepositoryFile,
} from "../extensions/repository";
import "./appearance.css";

export function Appearance() {
  const { values, set, blocked } = usePreferences();
  const catalog = useThemes();
  const { theme, mode, style, missing } = useTheme();
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState<CanvasTheme | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasImage, setHasImage] = useState(false);
  const [repository, setRepository] = useState("");
  const [reference, setReference] = useState("main");
  const [resetCollection, setResetCollection] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void readWallpaper()
      .then((blob) => {
        if (alive.current) setHasImage(Boolean(blob));
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      abort.current?.abort();
    };
  }, []);
  async function task(work: () => Promise<void>) {
    if (busy) return;
    abort.current = null;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await work();
    } catch (error) {
      if (alive.current)
        setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function apply(item: CanvasTheme) {
    set("themeId", item.id);
    setStatus(
      `${item.name} applied. Your wallpaper and size choices are preserved.`,
    );
  }
  return (
    <div className="appearance">
      <div className="appearance-heading">
        <h3>Make room for your own style</h3>
        <span>
          {mode === "light" ? <Sun size={14} /> : <Moon size={14} />}{" "}
          {mode === "light" ? "Daylight" : "After hours"}
        </span>
      </div>
      <div className="theme-collection" aria-label="Installed themes">
        {catalog.themes.map((item) => {
          const colors = resolveTheme(item, mode).style.colors;
          return (
            <button
              key={item.id}
              className="theme-card"
              aria-pressed={theme.id === item.id}
              disabled={blocked}
              onClick={() => apply(item)}
              style={
                {
                  "--preview-sky": colors.sky,
                  "--preview-mid": colors.mid,
                  "--preview-near": colors.near,
                  "--preview-surface": colors.surface,
                  "--preview-raised": colors.raised,
                  "--preview-text": colors.text,
                } as CSSProperties
              }
            >
              <span className="theme-miniature" aria-hidden="true">
                <i className="theme-miniature-ridge" />
                <i className="theme-miniature-window">
                  <b />
                  <em />
                  <em />
                  <em />
                </i>
                <i className="theme-miniature-dock">
                  <b />
                  <b />
                  <b />
                </i>
              </span>
              <span className="theme-card-name">
                {item.name}
                {theme.id === item.id && <Check size={15} />}
              </span>
              <small>
                {item.id === canvasTheme.id
                  ? "Built in"
                  : item.author || "Installed theme"}{" "}
                ·{" "}
                {item.variants.light && item.variants.dark
                  ? "Light & dark"
                  : item.variants.light
                    ? "Light"
                    : "Dark"}
              </small>
            </button>
          );
        })}
      </div>
      <p className="appearance-description">{theme.description}</p>
      <div className="appearance-modes" role="group" aria-label="Color mode">
        {(["light", "dark", "system"] as const).map((value) => (
          <button
            key={value}
            disabled={blocked}
            aria-pressed={values.themeMode === value}
            onClick={() => set("themeMode", value)}
          >
            {value === "light"
              ? "Light"
              : value === "dark"
                ? "Dark"
                : "Follow system"}
          </button>
        ))}
      </div>
      {(!theme.variants.light || !theme.variants.dark) && (
        <p className="preferences-hint">
          This theme supplies only its {mode} variant. It is used for every
          color-mode choice.
        </p>
      )}
      {missing && (
        <p role="status" className="preferences-hint">
          The selected theme is unavailable. Canvas is in use.
        </p>
      )}
      {catalog.error && (
        <div role="alert" className="inline-error">
          {catalog.error}
          <button onClick={() => setResetCollection(true)}>
            Reset installed themes…
          </button>
          {resetCollection && (
            <p>
              Remove the unreadable collection?
              <button
                onClick={() => {
                  try {
                    catalog.reset();
                    set("themeId", canvasTheme.id);
                    setResetCollection(false);
                  } catch (error) {
                    setError(String(error));
                  }
                }}
              >
                Reset collection
              </button>
              <button onClick={() => setResetCollection(false)}>Cancel</button>
            </p>
          )}
        </div>
      )}
      <div className="theme-install-actions">
        <label className="appearance-file-button">
          <Download size={14} /> Install theme file
          <input
            aria-label="Install theme file"
            disabled={busy || catalog.blocked || blocked}
            type="file"
            accept=".json,.shellcanvas-theme"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              void task(async () => {
                if (file.size > themeLimit)
                  throw new Error("Theme files must be 32 KB or smaller.");
                const raw = await new Promise<string>((resolve, reject) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(String(reader.result));
                  reader.onerror = () =>
                    reject(new Error("Theme file could not be read."));
                  reader.readAsText(file);
                });
                const item = parseTheme(raw);
                if (alive.current) setPending(item);
              });
            }}
          />
        </label>
        {theme.id !== canvasTheme.id && (
          <button
            disabled={busy || blocked}
            onClick={() => {
              try {
                catalog.remove(theme.id);
                set("themeId", canvasTheme.id);
                setStatus("Theme removed. Canvas is now active.");
              } catch (error) {
                setError(String(error));
              }
            }}
          >
            <Trash2 size={14} /> Remove theme
          </button>
        )}
      </div>
      <details className="theme-repository">
        <summary>Install from GitHub</summary>
        <p>Enter the repository containing shellcanvas.theme.json.</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void task(async () => {
              const location = parseRepositoryLocation(repository, reference);
              const controller = new AbortController();
              abort.current = controller;
              const raw = await readRepositoryFile(
                location,
                "shellcanvas.theme.json",
                themeLimit,
                controller.signal,
              );
              const item = parseTheme(raw);
              if (alive.current) setPending(item);
            });
          }}
        >
          <input
            aria-label="Theme GitHub repository"
            placeholder="owner/repository"
            value={repository}
            onChange={(event) => setRepository(event.target.value)}
            required
          />
          <input
            aria-label="Theme branch, tag or commit"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            required
          />
          <button disabled={busy || blocked || catalog.blocked}>
            Review theme
          </button>
          {busy && abort.current && (
            <button type="button" onClick={() => abort.current?.abort()}>
              Cancel
            </button>
          )}
        </form>
      </details>
      {pending && (
        <div className="theme-review" role="region" aria-label="Review theme">
          <strong>
            {pending.name} · {pending.version}
          </strong>
          <p>{pending.description || "A custom theme for your desktop."}</p>
          <small>
            {pending.id} · {pending.author || "Author not specified"}
          </small>
          <p>
            Colors and desktop styling only. No scripts, network resources or
            host access.
            {catalog.themes.some((item) => item.id === pending.id)
              ? " This replaces the installed version."
              : ""}
          </p>
          <button
            disabled={blocked || busy}
            onClick={() => {
              try {
                catalog.install(pending);
                apply(pending);
                setPending(null);
              } catch (error) {
                setError(String(error));
              }
            }}
          >
            Install and apply
          </button>
          <button onClick={() => setPending(null)}>Cancel</button>
        </div>
      )}
      <h3>Wallpaper</h3>
      <div className="wallpaper-options">
        {(["theme", "fjord", "dusk", "sage"] as const).map((name) => (
          <button
            key={name}
            className={`wallpaper-swatch swatch-${name}`}
            aria-label={`${name} wallpaper`}
            aria-pressed={values.wallpaper === name}
            disabled={blocked}
            onClick={() => set("wallpaper", name)}
          >
            {values.wallpaper === name && <Check size={20} />}
            <span>{name === "theme" ? "Theme landscape" : name}</span>
          </button>
        ))}
      </div>
      <div className="theme-install-actions">
        <label className="appearance-file-button">
          <ImagePlus size={15} /> Choose a photo
          <input
            aria-label="Choose wallpaper image"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={busy || blocked}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              void task(async () => {
                const blob = await prepareWallpaper(file);
                if (!alive.current) return;
                await saveWallpaper(blob);
                if (alive.current) {
                  setHasImage(true);
                  set("wallpaper", "custom");
                  setStatus("Wallpaper saved on this device.");
                }
              });
            }}
          />
        </label>
        {hasImage && (
          <>
            <button
              disabled={blocked}
              aria-pressed={values.wallpaper === "custom"}
              onClick={() => set("wallpaper", "custom")}
            >
              Use my photo
            </button>
            <button
              disabled={busy || blocked}
              onClick={() =>
                void task(async () => {
                  await saveWallpaper();
                  if (alive.current) {
                    setHasImage(false);
                    if (values.wallpaper === "custom")
                      set("wallpaper", "theme");
                  }
                })
              }
            >
              Remove photo
            </button>
          </>
        )}
      </div>
      {values.wallpaper === "custom" && (
        <label className="appearance-control">
          Photo placement
          <select
            aria-label="Photo placement"
            disabled={blocked}
            value={values.wallpaperFit}
            onChange={(event) =>
              set(
                "wallpaperFit",
                event.target.value as "cover" | "contain" | "tile",
              )
            }
          >
            <option value="cover">Fill screen</option>
            <option value="contain">Fit whole image</option>
            <option value="tile">Tile</option>
          </select>
        </label>
      )}
      {values.wallpaper === "custom" && !hasImage && (
        <p role="status" className="preferences-hint">
          No saved photo is available. The theme landscape is shown.
        </p>
      )}
      <h3>Size & comfort</h3>
      <div className="preferences-group">
        <label className="appearance-control">
          <span>
            Interface scale<small>Text, controls and spacing</small>
          </span>
          <select
            aria-label="Interface scale"
            disabled={blocked}
            value={values.uiScale}
            onChange={(event) => set("uiScale", Number(event.target.value))}
          >
            {[80, 90, 100, 110, 125, 150].map((n) => (
              <option key={n} value={n}>
                {n}%{n === 100 ? " · Default" : ""}
              </option>
            ))}
          </select>
        </label>
        {(["toolbarHeight", "dockSize"] as const).map((key) => (
          <label className="appearance-control" key={key}>
            <span>
              {key === "toolbarHeight" ? "Top toolbar" : "Dock icons"}
              <small>{values[key] || style[key]} px at 100% scale</small>
            </span>
            <input
              aria-label={
                key === "toolbarHeight" ? "Top toolbar size" : "Dock icon size"
              }
              type="range"
              min={key === "toolbarHeight" ? 36 : 32}
              max={64}
              step={1}
              disabled={blocked}
              value={values[key] || style[key]}
              onChange={(event) => set(key, Number(event.target.value))}
            />
          </label>
        ))}
      </div>
      <button
        className="appearance-reset"
        disabled={blocked}
        onClick={() => {
          set("uiScale", 100);
          set("toolbarHeight", 0);
          set("dockSize", 0);
          set("wallpaper", "theme");
        }}
      >
        Use theme wallpaper and default sizes
      </button>
      {busy && <p role="status">Preparing…</p>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="preferences-hint" role="status">
          {status}
        </p>
      )}
    </div>
  );
}
