// SPDX-License-Identifier: MPL-2.0
import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronDown, Plus, Search, Server } from "lucide-react";
import type { HostProfile } from "../sdk";
import "./HostProfilePicker.css";

export function HostProfilePicker({
  profiles,
  value,
  disabled,
  onChange,
}: {
  profiles: HostProfile[];
  value: string;
  disabled: boolean;
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const entries = profiles.map((profile, index) => ({
    profile,
    key: profile.id ?? `import-${index}`,
  }));
  const selected = entries.find((entry) => entry.key === value)?.profile;
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = entries
    .filter(({ profile: p }) => {
      const text =
        `${p.name} ${p.host} ${p.username} ${p.port} ${p.id ? "saved" : "ssh config"}`.toLocaleLowerCase();
      return tokens.every((token) => text.includes(token));
    })
    .sort(
      (a, b) =>
        Number(!a.profile.id) - Number(!b.profile.id) ||
        a.profile.name.localeCompare(b.profile.name, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
    );
  const focused = matches[Math.min(active, Math.max(0, matches.length - 1))];
  const dismiss = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const choose = (key: string) => {
    onChange(key);
    dismiss();
  };
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);
  useEffect(() => {
    const option = list.current?.querySelector<HTMLElement>(
      '[data-active="true"]',
    );
    if (!option || !list.current) return;
    const row = option.getBoundingClientRect();
    const bounds = list.current.getBoundingClientRect();
    if (row.top < bounds.top) list.current.scrollTop -= bounds.top - row.top;
    else if (row.bottom > bounds.bottom)
      list.current.scrollTop += row.bottom - bounds.bottom;
  }, [active, query, open]);
  return (
    <div
      ref={root}
      className="host-picker"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOpen(false);
      }}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
        }
      }}
    >
      <span className="host-picker-label">Your hosts</span>
      <button
        ref={trigger}
        type="button"
        className="host-picker-trigger"
        disabled={disabled}
        aria-label="Choose host profile"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          setOpen(!open);
          setQuery("");
          setActive(0);
        }}
      >
        <Server size={16} />
        <span>
          <strong>{selected?.name || "New host"}</strong>
          <small>
            {selected
              ? `${selected.username}@${selected.host}:${selected.port}`
              : "Add a connection to your workspace"}
          </small>
        </span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div id={id} className="host-picker-panel">
          <div className="host-picker-search">
            <Search size={15} />
            <input
              ref={search}
              value={query}
              role="combobox"
              aria-label="Search hosts"
              aria-autocomplete="list"
              aria-expanded={true}
              aria-controls={`${id}-list`}
              aria-activedescendant={
                focused ? `${id}-${focused.key}` : undefined
              }
              placeholder="Search name, host or username…"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (focused) choose(focused.key);
                } else if (
                  ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
                ) {
                  if (event.key === "Home" || event.key === "End") {
                    if (!event.ctrlKey) return;
                  }
                  event.preventDefault();
                  setActive((old) =>
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? Math.max(0, matches.length - 1)
                        : Math.max(
                            0,
                            Math.min(
                              matches.length - 1,
                              old + (event.key === "ArrowDown" ? 1 : -1),
                            ),
                          ),
                  );
                }
              }}
            />
          </div>
          <div
            ref={list}
            id={`${id}-list`}
            role="listbox"
            aria-label="Host profiles"
            className="host-picker-list"
          >
            {([true, false] as const).map((saved) => {
              const group = matches.filter(
                (entry) => !!entry.profile.id === saved,
              );
              return (
                group.length > 0 && (
                  <div
                    role="group"
                    aria-label={
                      saved ? "Saved on this device" : "Imported SSH config"
                    }
                    key={String(saved)}
                  >
                    <div className="host-picker-group">
                      {saved ? "Saved on this device" : "SSH config"}
                      <span>{group.length}</span>
                    </div>
                    {group.map((entry) => (
                      <button
                        type="button"
                        role="option"
                        tabIndex={-1}
                        id={`${id}-${entry.key}`}
                        key={entry.key}
                        aria-selected={entry.key === value}
                        data-active={entry.key === focused?.key}
                        onClick={() => choose(entry.key)}
                      >
                        <Server size={15} />
                        <span>
                          <strong>{entry.profile.name}</strong>
                          <small>
                            {entry.profile.username}@{entry.profile.host}:
                            {entry.profile.port}
                          </small>
                        </span>
                        {entry.key === value && <Check size={14} />}
                      </button>
                    ))}
                  </div>
                )
              );
            })}
          </div>
          {!matches.length && (
            <p className="host-picker-empty" role="status">
              {profiles.length
                ? "No matching hosts."
                : "Your saved hosts will appear here."}
            </p>
          )}
          <div className="host-picker-bottom">
            <span>
              {matches.length} of {profiles.length} hosts
            </span>
            <button type="button" onClick={() => choose("")}>
              <Plus size={14} /> New host
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
