// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Cable, Plus, X } from "lucide-react";
import {
  adapterProfile,
  type AdapterConnectionOptions,
  type AdapterInfo,
  type AdapterProfile,
  type AdapterServices,
  type Configuration,
} from "../adapters";
import "./ConnectAdapterDialog.css";
const standardRoles: Record<string, string> = {
  files: "Files",
  console: "Terminal",
  "host.settings": "Remote settings",
};
interface SourceForm {
  key: string;
  id: string;
  configuration: Configuration;
  roles: string[];
  customInput?: string;
}
export function ConnectAdapterDialog({
  services,
  initial,
  replacing = false,
  busy,
  error,
  close,
  cancel,
  manage,
  submit,
}: {
  services: AdapterServices;
  initial?: AdapterProfile;
  replacing?: boolean;
  busy: boolean;
  error: string;
  close(): void;
  cancel(): void;
  manage(): void;
  submit(
    options: AdapterConnectionOptions,
    profile: AdapterProfile,
  ): Promise<void>;
}) {
  const [installed, setInstalled] = useState<AdapterInfo[]>([]),
    [loading, setLoading] = useState(true),
    [failure, setFailure] = useState(""),
    [name, setName] = useState(initial?.name ?? ""),
    [sources, setSources] = useState<SourceForm[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);
  function defaults(item: AdapterInfo) {
    return Object.fromEntries(
      item.configuration
        .filter(
          (field) =>
            field.kind === "boolean" ||
            (field.default !== undefined && field.default !== null),
        )
        .map((field) => [field.id, field.default ?? false]),
    ) as Configuration;
  }
  useEffect(() => {
    let active = true;
    void services
      .list()
      .then((items) => {
        if (!active) return;
        setInstalled(items);
        setSources(
          initial
            ? initial.sources.map((source) => ({
                key: source.key,
                id: source.id,
                configuration: { ...source.configuration },
                roles: Object.entries(initial.bindings)
                  .filter(([, key]) => key === source.key)
                  .map(([role]) => role) as SourceForm["roles"],
              }))
            : items.some((item) => item.enabled)
              ? [
                  {
                    key: crypto.randomUUID(),
                    id: items.find((item) => item.enabled)!.id,
                    configuration: defaults(
                      items.find((item) => item.enabled)!,
                    ),
                    roles: ["files", "console"],
                  },
                ]
              : [],
        );
      })
      .catch((error) => {
        if (active) setFailure(String(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [services, initial]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>("input,button")?.focus();
    return () => previous?.focus();
  }, []);
  const change = (key: string, patch: Partial<SourceForm>) =>
    setSources((sources) =>
      sources.map((source) =>
        source.key === key ? { ...source, ...patch } : source,
      ),
    );
  const locked = busy || loading;
  return (
    <div className="modal-backdrop">
      <dialog
        ref={dialog}
        open
        aria-modal="true"
        aria-labelledby="adapter-connect-title"
        className="connect-dialog adapter-connect"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            if (busy) cancel();
            close();
          }
          if (event.key === "Tab") {
            const controls = Array.from(
              dialog.current?.querySelectorAll<HTMLElement>(
                "button:not(:disabled),input:not(:disabled),select:not(:disabled)",
              ) ?? [],
            );
            const first = controls[0],
              last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <button
          className="dialog-close icon-button"
          aria-label="Close adapter connection"
          onClick={() => {
            if (busy) cancel();
            close();
          }}
        >
          <X size={19} />
        </button>
        <div className="connection-emblem">
          <Cable size={25} />
        </div>
        <p className="eyebrow">A WORKSPACE, YOUR WAY</p>
        <h1 id="adapter-connect-title">
          {replacing
            ? "Replace this connection."
            : initial
              ? "Reconnect your workspace."
              : "Choose your connections."}
        </h1>
        <p className="dialog-intro">
          {replacing
            ? "The selected services will use this connection. Other connections stay open, and editor drafts are preserved."
            : "Use one adapter for everything, or combine separate file and terminal connections."}
        </p>
        {(error || failure) && (
          <p className="inline-error" role="alert">
            {error || failure}
          </p>
        )}
        {loading && <p role="status">Loading connection adapters…</p>}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setFailure("");
            void (async () => {
              try {
                const bindings: AdapterConnectionOptions["bindings"] = {};
                const options: AdapterConnectionOptions = {
                  name: name.trim(),
                  sources: sources.map((source) => {
                    const item = installed.find(
                      (item) => item.id === source.id && item.enabled,
                    );
                    if (!item)
                      throw new Error(
                        "Select an enabled adapter for each connection.",
                      );
                    if (!source.roles.length)
                      throw new Error(
                        "Choose at least one service for each connection.",
                      );
                    for (const role of source.roles) {
                      if (bindings[role])
                        throw new Error(
                          "Each service needs one explicit connection source.",
                        );
                      bindings[role] = source.key;
                    }
                    return {
                      key: source.key,
                      id: item.id,
                      revision: item.revision,
                      configuration: source.configuration,
                    };
                  }),
                  bindings,
                };
                await submit(options, adapterProfile(options, installed));
              } catch (error) {
                setFailure(String(error));
              }
            })();
          }}
        >
          <fieldset disabled={locked}>
            {!replacing && (
              <label className="form-field">
                Workspace name
                <input
                  required
                  maxLength={200}
                  value={name}
                  readOnly={replacing}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="My device workspace"
                />
              </label>
            )}
            {sources.map((source, index) => {
              const item = installed.find((item) => item.id === source.id);
              return (
                <section
                  className="adapter-source"
                  key={source.key}
                  aria-label={`Connection ${index + 1}`}
                >
                  <div className="adapter-source-heading">
                    <h3>
                      {replacing
                        ? source.roles
                            .map((role) => standardRoles[role] ?? role)
                            .join(" + ")
                        : `Connection ${index + 1}`}
                    </h3>
                    {!initial && sources.length > 1 && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove connection ${index + 1}`}
                        onClick={() =>
                          setSources(
                            sources.filter((item) => item.key !== source.key),
                          )
                        }
                      >
                        <X size={15} />
                      </button>
                    )}
                  </div>
                  <label className="form-field">
                    Adapter
                    <select
                      disabled={!!initial && !replacing}
                      value={source.id}
                      onChange={(event) => {
                        const selected = installed.find(
                          (item) => item.id === event.target.value,
                        )!;
                        change(source.key, {
                          id: selected.id,
                          configuration: defaults(selected),
                        });
                      }}
                    >
                      {!item && (
                        <option value={source.id}>
                          Adapter no longer installed
                        </option>
                      )}
                      {installed
                        .filter((item) => item.enabled || item.id === source.id)
                        .map((item) => (
                          <option
                            key={item.id}
                            value={item.id}
                            disabled={!item.enabled}
                          >
                            {item.name} · {item.version}
                            {!item.enabled ? " · disabled" : ""}
                          </option>
                        ))}
                    </select>
                  </label>
                  {!replacing && (
                    <div className="adapter-roles">
                      {Object.keys(standardRoles).map((role) => (
                        <label key={role}>
                          <input
                            type="checkbox"
                            disabled={!!initial}
                            checked={source.roles.includes(role)}
                            onChange={(event) =>
                              change(source.key, {
                                roles: event.target.checked
                                  ? [...source.roles, role]
                                  : source.roles.filter(
                                      (value) => value !== role,
                                    ),
                              })
                            }
                          />
                          {standardRoles[role]}
                        </label>
                      ))}
                    </div>
                  )}
                  {!replacing && (
                    <label className="form-field">
                      Additional services
                      <input
                        disabled={!!initial}
                        placeholder="Service IDs, separated by commas"
                        value={
                          source.customInput ??
                          source.roles
                            .filter(
                              (role) => !Object.hasOwn(standardRoles, role),
                            )
                            .join(", ")
                        }
                        onChange={(event) =>
                          change(source.key, {
                            customInput: event.target.value,
                            roles: [
                              ...source.roles.filter((role) =>
                                Object.hasOwn(standardRoles, role),
                              ),
                              ...event.target.value
                                .split(",")
                                .map((role) => role.trim())
                                .filter(Boolean),
                            ],
                          })
                        }
                      />
                    </label>
                  )}
                  {item?.configuration.map((field) => (
                    <label className="form-field" key={field.id}>
                      {field.label}
                      {field.kind === "boolean" ? (
                        <input
                          type="checkbox"
                          checked={source.configuration[field.id] === true}
                          onChange={(event) =>
                            change(source.key, {
                              configuration: {
                                ...source.configuration,
                                [field.id]: event.target.checked,
                              },
                            })
                          }
                        />
                      ) : (
                        <input
                          autoComplete={
                            field.kind === "password" ? "new-password" : "off"
                          }
                          type={
                            field.kind === "password"
                              ? "password"
                              : field.kind === "number"
                                ? "number"
                                : "text"
                          }
                          required={field.required}
                          value={String(source.configuration[field.id] ?? "")}
                          onChange={(event) => {
                            const configuration = { ...source.configuration };
                            if (
                              field.kind === "number" &&
                              event.target.value === ""
                            )
                              delete configuration[field.id];
                            else
                              configuration[field.id] =
                                field.kind === "number"
                                  ? Number(event.target.value)
                                  : event.target.value;
                            change(source.key, { configuration });
                          }}
                        />
                      )}
                    </label>
                  ))}
                </section>
              );
            })}
            {!initial && installed.some((item) => item.enabled) && (
              <button
                className="adapter-add"
                type="button"
                onClick={() => {
                  const item = installed.find((item) => item.enabled)!;
                  setSources([
                    ...sources,
                    {
                      key: crypto.randomUUID(),
                      id: item.id,
                      configuration: defaults(item),
                      roles: [],
                    },
                  ]);
                }}
              >
                <Plus size={14} />
                Add another connection
              </button>
            )}
            {!loading && !installed.length && (
              <p>
                No connection adapters installed yet. Open Apps to install one.
              </p>
            )}
          </fieldset>
          <button
            type="button"
            className="adapter-add"
            disabled={busy}
            onClick={manage}
          >
            Manage connection adapters
          </button>
          <button
            type="submit"
            className="primary-button connect-submit"
            disabled={locked || !sources.length}
          >
            {busy
              ? "Connecting…"
              : replacing
                ? "Replace connection"
                : initial
                  ? "Reconnect workspace"
                  : "Open workspace"}
            <ArrowUpRight size={17} />
          </button>
          {busy && (
            <button
              type="button"
              className="cancel-connection"
              onClick={cancel}
            >
              Cancel connection
            </button>
          )}
        </form>
        <p className="trust-note">
          Password fields are used for this connection and are not kept in the
          workspace profile.
        </p>
      </dialog>
    </div>
  );
}
