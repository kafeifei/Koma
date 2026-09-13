import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
  type Accessor,
  type Component,
} from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import type { IntegrationInfo, PluginInfo } from "@opencode-ai/schema/koma-extensions"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { ExtensionCatalogView, ExtensionViewSwitch } from "./extension-catalog"
import "./extensions.css"

function options(text: string): Record<string, unknown> {
  const value = JSON.parse(text)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.")
  return value
}

export const SettingsPluginsV2: Component = () => {
  const language = useLanguage()
  const t = language.t
  const sdk = useServerSDK()
  const api = createMemo(() => sdk().currentApi.extensions)
  const [plugins, { refetch }] = createResource(api, (api) => api.plugins())
  const [view, setView] = createSignal<"discover" | "installed">("discover")
  const [busy, setBusy] = createSignal(false)
  const [installing, setInstalling] = createSignal<string>()
  const [error, setError] = createSignal("")
  const [editor, setEditor] = createSignal<PluginInfo | "new">()
  const [spec, setSpec] = createSignal("")
  const [config, setConfig] = createSignal("{}")
  const run = async (action: () => Promise<unknown>) => {
    if (busy()) return
    setBusy(true)
    setError("")
    try {
      await action()
      await refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const edit = (item?: PluginInfo, initial = "") => {
    setView("installed")
    setSpec(item?.spec ?? initial)
    setConfig(JSON.stringify(item?.options ?? {}, null, 2))
    setEditor(item ?? "new")
  }
  createEffect(() => {
    api()
    setEditor(undefined)
    setError("")
  })
  const save = () =>
    run(async () => {
      const current = editor()
      const value = options(config())
      if (current && current !== "new") await api().change({ id: current.id, enabled: current.enabled, options: value })
      else await api().install({ spec: spec(), options: value })
      setEditor(undefined)
    })
  const state = (item: PluginInfo) => {
    if (item.pending) return t("settings.extensions.pending")
    if (item.runtime.some((r) => r.status === "failed")) return t("settings.extensions.failed")
    if (item.runtime.some((r) => r.status === "active")) return t("settings.extensions.active")
    if (!item.enabled) return t("settings.extensions.disabled")
    return t("settings.extensions.ready")
  }
  return (
    <>
      <div class="settings-v2-tab-header extension-header">
        <h2 class="settings-v2-tab-title">{t("settings.extensions.plugins")}</h2>
        <ButtonV2 size="small" disabled={busy()} onClick={() => edit()}>
          {t("settings.extensions.addPlugin")}
        </ButtonV2>
      </div>
      <div class="settings-v2-tab-body extension-body" data-testid="settings-plugins">
        <p class="extension-note">{t("settings.extensions.pluginScope")}</p>
        <ExtensionViewSwitch
          value={view()}
          count={plugins()?.filter((p) => p.installed).length ?? 0}
          onChange={setView}
        />
        <Show when={error() || plugins.error}>
          <p role="alert" class="extension-error">
            {error() || String(plugins.error)}
          </p>
        </Show>
        <Show when={view() === "discover"}>
          <ExtensionCatalogView
            kind="plugins"
            busy={busy()}
            installing={installing()}
            installed={(entry) =>
              !!plugins()?.some((p) => (p.catalogID === entry.id || p.id === entry.plugin?.spec) && p.installed)
            }
            onSelect={(entry) => {
              const current = api()
              void run(async () => {
                setInstalling(entry.id)
                try {
                  await current.installCatalog(entry.id)
                  if (api() === current) setView("installed")
                } finally {
                  setInstalling(undefined)
                }
              })
            }}
          />
        </Show>

        <Show when={plugins.loading}>
          <p role="status">{t("settings.extensions.loading")}</p>
        </Show>
        <Show when={view() === "installed"}>
          <p class="extension-note">{t("settings.extensions.trust")}</p>
          <Show when={editor()}>
            <form
              class="extension-editor"
              onSubmit={(e) => {
                e.preventDefault()
                void save()
              }}
            >
              <label>
                {t("settings.extensions.package")}
                <input
                  required
                  value={spec()}
                  disabled={editor() !== "new" || busy()}
                  onInput={(e) => setSpec(e.currentTarget.value)}
                  placeholder="@scope/plugin@version / /path/plugin.ts"
                />
              </label>
              <label>
                {t("settings.extensions.options")}
                <textarea
                  rows={5}
                  value={config()}
                  disabled={busy()}
                  onInput={(e) => setConfig(e.currentTarget.value)}
                  spellcheck={false}
                />
              </label>
              <div class="extension-actions">
                <ButtonV2 type="button" variant="outline" disabled={busy()} onClick={() => setEditor(undefined)}>
                  {t("settings.extensions.cancel")}
                </ButtonV2>
                <ButtonV2 type="submit" disabled={busy()}>
                  {busy() ? t("settings.extensions.working") : t("settings.extensions.save")}
                </ButtonV2>
              </div>
            </form>
          </Show>
          <section class="settings-v2-section">
            <div class="extension-header">
              <h3 class="settings-v2-section-title">{t("settings.extensions.installed")}</h3>
              <ButtonV2
                size="small"
                variant="ghost"
                disabled={busy() || plugins.loading}
                onClick={() => void run(async () => refetch())}
              >
                {t("settings.extensions.refresh")}
              </ButtonV2>
            </div>
            <Show
              when={plugins()?.length}
              fallback={<p class="extension-note">{t("settings.extensions.emptyPlugins")}</p>}
            >
              <SettingsListV2>
                <For each={plugins()}>
                  {(item) => (
                    <SettingsRowV2
                      title={item.name ?? item.id}
                      description={
                        <>
                          <span class="extension-spec">{item.spec}</span>
                          <span class="extension-status">
                            {state(item)} ·{" "}
                            {item.resourceKind === "instructions" ? t("settings.extensions.instructions") : "OpenCode"}
                          </span>
                          <Show when={!item.managed}>
                            <span>{t("settings.extensions.external")}</span>
                          </Show>
                          <Show when={item.pending}>
                            <span>{t("settings.extensions.reloadNote")}</span>
                          </Show>
                          <For each={item.runtime.filter((r) => r.error)}>
                            {(r) => (
                              <span class="extension-error">
                                {r.directory}: {r.error}
                              </span>
                            )}
                          </For>
                        </>
                      }
                    >
                      <div class="extension-actions">
                        <Switch
                          hideLabel
                          checked={item.enabled}
                          disabled={busy() || !item.managed || !item.installed}
                          onChange={(enabled) => void run(() => api().change({ id: item.id, enabled }))}
                        >
                          {t("settings.extensions.enable")} {item.name ?? item.id}
                        </Switch>
                        <Show when={item.managed && item.installed}>
                          <ButtonV2 size="small" variant="ghost" disabled={busy()} onClick={() => edit(item)}>
                            {t("settings.extensions.configure")}
                          </ButtonV2>
                          <ButtonV2
                            size="small"
                            variant="ghost"
                            disabled={busy()}
                            onClick={() => void run(() => api().uninstall(item.id))}
                          >
                            {t("settings.extensions.uninstall")}
                          </ButtonV2>
                        </Show>
                      </div>
                    </SettingsRowV2>
                  )}
                </For>
              </SettingsListV2>
            </Show>
          </section>
        </Show>
      </div>
    </>
  )
}

export const SettingsIntegrationsV2: Component<{ directory: Accessor<string | undefined> }> = (props) => {
  const t = useLanguage().t
  const sdk = useServerSDK()
  const source = createMemo(() =>
    props.directory() ? { api: sdk().currentApi.extensions, directory: props.directory()! } : undefined,
  )
  const [items, { refetch }] = createResource(source, ({ api, directory }) => api.integrations(directory))
  const [view, setView] = createSignal<"discover" | "installed">("discover")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const [editor, setEditor] = createSignal(false)
  const [editing, setEditing] = createSignal(false)
  const [name, setName] = createSignal("")
  const [connectionType, setConnectionType] = createSignal("remote")
  const [endpoint, setEndpoint] = createSignal("")
  const [command, setCommand] = createSignal("")
  const [args, setArgs] = createSignal("")
  const [config, setConfig] = createSignal(
    '{\n  "type": "remote",\n  "url": "https://example.com/mcp",\n  "enabled": true\n}',
  )
  const run = async (action: (current: NonNullable<ReturnType<typeof source>>) => Promise<unknown>) => {
    const current = source()
    if (!current || busy()) return
    setBusy(true)
    setError("")
    try {
      await action(current)
      await refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const edit = (item?: IntegrationInfo, initial?: { name: string; url: string; oauth: boolean }) => {
    setView("installed")
    setName(item?.name ?? initial?.name ?? "")
    setEditing(!!item)
    setConnectionType(item?.config.type === "local" ? "local" : "remote")
    setEndpoint(typeof item?.config.url === "string" ? item.config.url : (initial?.url ?? ""))
    const command = Array.isArray(item?.config.command) ? item.config.command : []
    setCommand(String(command[0] ?? ""))
    setArgs(command.slice(1).join("\n"))
    const {
      type: _type,
      url: _url,
      command: _command,
      ...extra
    } = item?.config ?? { enabled: true, ...(initial?.oauth ? { oauth: {} } : {}) }
    setConfig(JSON.stringify(extra, null, 2))
    setEditor(true)
  }
  createEffect(() => {
    source()
    setEditor(false)
    setError("")
  })
  const toggle = (item: IntegrationInfo, enabled: boolean) =>
    run(({ api, directory }) =>
      api.saveIntegration(directory, { name: item.name, config: { ...item.config, enabled } }),
    )
  return (
    <>
      <div class="settings-v2-tab-header extension-header">
        <h2 class="settings-v2-tab-title">{t("settings.extensions.integrations")}</h2>
        <ButtonV2 size="small" disabled={!source() || busy()} onClick={() => edit()}>
          {t("settings.extensions.addIntegration")}
        </ButtonV2>
      </div>
      <div class="settings-v2-tab-body extension-body" data-testid="settings-integrations">
        <p class="extension-note">
          {t("settings.extensions.integrationScope")}
          <span class="extension-spec">{props.directory() ?? t("settings.extensions.selectProject")}</span>
        </p>
        <ExtensionViewSwitch value={view()} count={items()?.length ?? 0} onChange={setView} />
        <Show when={error() || items.error}>
          <p role="alert" class="extension-error">
            {error() || String(items.error)}
          </p>
        </Show>
        <Show when={view() === "discover"}>
          <ExtensionCatalogView
            kind="integrations"
            busy={busy()}
            canConfigure={!!source() && !items.loading && !items.error}
            installed={(entry) =>
              !!items()?.some((item) => item.name === entry.mcp?.name || item.config.url === entry.mcp?.url)
            }
            onSelect={(entry) => edit(undefined, entry.mcp)}
          />
        </Show>
        <Show when={items.loading}>
          <p role="status">{t("settings.extensions.loading")}</p>
        </Show>
        <Show when={view() === "installed"}>
          <Show when={editor() && source()}>
            <form
              class="extension-editor"
              onSubmit={(e) => {
                e.preventDefault()
                void run(async ({ api, directory }) => {
                  const extra = options(config())
                  const { type: _type, url: _url, command: _command, ...rest } = extra
                  const value =
                    connectionType() === "remote"
                      ? { ...rest, type: "remote", url: endpoint() }
                      : {
                          ...rest,
                          type: "local",
                          command: [
                            command(),
                            ...args()
                              .split("\n")
                              .filter((s) => s.length),
                          ],
                        }
                  await api.saveIntegration(directory, { name: name(), config: value })
                  setEditor(false)
                })
              }}
            >
              <label>
                {t("settings.extensions.name")}
                <input
                  required
                  pattern="([a-zA-Z0-9_]|-){1,80}"
                  value={name()}
                  disabled={editing() || busy()}
                  onInput={(e) => setName(e.currentTarget.value)}
                />
              </label>
              <label>
                {t("settings.extensions.connectionType")}
                <select
                  value={connectionType()}
                  disabled={busy()}
                  onChange={(e) => setConnectionType(e.currentTarget.value)}
                >
                  <option value="remote">{t("settings.extensions.remote")}</option>
                  <option value="local">{t("settings.extensions.local")}</option>
                </select>
              </label>
              <Show
                when={connectionType() === "remote"}
                fallback={
                  <>
                    <label>
                      {t("settings.extensions.command")}
                      <input
                        required
                        value={command()}
                        disabled={busy()}
                        onInput={(e) => setCommand(e.currentTarget.value)}
                        placeholder="npx"
                      />
                    </label>
                    <label>
                      {t("settings.extensions.arguments")}
                      <textarea
                        rows={3}
                        value={args()}
                        disabled={busy()}
                        onInput={(e) => setArgs(e.currentTarget.value)}
                        spellcheck={false}
                      />
                    </label>
                  </>
                }
              >
                <label>
                  {t("settings.extensions.endpoint")}
                  <input
                    required
                    type="url"
                    value={endpoint()}
                    disabled={busy()}
                    onInput={(e) => setEndpoint(e.currentTarget.value)}
                    placeholder="https://example.com/mcp"
                  />
                </label>
              </Show>
              <details>
                <summary>{t("settings.extensions.advanced")}</summary>
                <label>
                  {t("settings.extensions.mcpConfig")}
                  <textarea
                    rows={6}
                    value={config()}
                    disabled={busy()}
                    onInput={(e) => setConfig(e.currentTarget.value)}
                    spellcheck={false}
                  />
                </label>
                <p class="extension-note">{t("settings.extensions.mcpHelp")}</p>
              </details>
              <div class="extension-actions">
                <ButtonV2 type="button" variant="outline" disabled={busy()} onClick={() => setEditor(false)}>
                  {t("settings.extensions.cancel")}
                </ButtonV2>
                <ButtonV2 type="submit" disabled={busy()}>
                  {busy() ? t("settings.extensions.working") : t("settings.extensions.save")}
                </ButtonV2>
              </div>
            </form>
          </Show>
          <Show when={source()}>
            <section class="settings-v2-section">
              <div class="extension-header">
                <h3 class="settings-v2-section-title">MCP</h3>
                <ButtonV2
                  size="small"
                  variant="ghost"
                  disabled={busy() || items.loading}
                  onClick={() => void run(async () => refetch())}
                >
                  {t("settings.extensions.refresh")}
                </ButtonV2>
              </div>
              <Show
                when={items()?.length}
                fallback={<p class="extension-note">{t("settings.extensions.emptyIntegrations")}</p>}
              >
                <SettingsListV2>
                  <For each={items()}>
                    {(item) => (
                      <SettingsRowV2
                        title={item.name}
                        description={
                          <>
                            <span class="extension-status">{t(`settings.extensions.status.${item.status}`)}</span>
                            <Show when={!item.managed}>
                              <span>{t("settings.extensions.external")}</span>
                            </Show>
                            <Show when={item.error}>
                              <span class="extension-error">{item.error}</span>
                            </Show>
                          </>
                        }
                      >
                        <div class="extension-actions">
                          <Switch
                            hideLabel
                            checked={item.enabled}
                            disabled={busy() || !item.managed}
                            onChange={(enabled) => void toggle(item, enabled)}
                          >
                            {t("settings.extensions.enable")} {item.name}
                          </Switch>
                          <Show when={item.status === "needs_auth" || item.status === "needs_client_registration"}>
                            <ButtonV2
                              size="small"
                              disabled={busy()}
                              onClick={() =>
                                void run(async ({ directory }) => {
                                  await sdk()
                                    .createClient({ directory })
                                    .mcp.auth.authenticate({ name: item.name, directory }, { throwOnError: true })
                                })
                              }
                            >
                              {t("settings.extensions.authorize")}
                            </ButtonV2>
                          </Show>
                          <Show when={item.managed}>
                            <ButtonV2 size="small" variant="ghost" disabled={busy()} onClick={() => edit(item)}>
                              {t("settings.extensions.configure")}
                            </ButtonV2>
                            <ButtonV2
                              size="small"
                              variant="ghost"
                              disabled={busy()}
                              onClick={() =>
                                void run(({ api, directory }) => api.removeIntegration(directory, item.name))
                              }
                            >
                              {t("settings.extensions.remove")}
                            </ButtonV2>
                          </Show>
                        </div>
                      </SettingsRowV2>
                    )}
                  </For>
                </SettingsListV2>
              </Show>
            </section>
          </Show>
        </Show>
      </div>
    </>
  )
}
