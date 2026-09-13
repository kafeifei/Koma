import { createEffect, createMemo, createResource, createSignal, For, Show, type Component } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import type { CatalogEntry } from "@opencode-ai/schema/koma-extensions"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"

function installable(entry: CatalogEntry) {
  return !!entry.mcp || ["npm", "files", "instructions"].includes(entry.installation?.type ?? "")
}
export const ExtensionViewSwitch: Component<{
  value: "discover" | "installed"
  count: number
  onChange: (value: "discover" | "installed") => void
}> = (props) => {
  const t = useLanguage().t
  return (
    <div class="extension-views" role="group" aria-label={t("settings.extensions.view")}>
      <For each={["discover", "installed"] as const}>
        {(view) => (
          <button type="button" aria-pressed={props.value === view} onClick={() => props.onChange(view)}>
            {t(`settings.extensions.${view}`)}
            <Show when={view === "installed"}>
              <span>{props.count}</span>
            </Show>
          </button>
        )}
      </For>
    </div>
  )
}

export const ExtensionCatalogView: Component<{
  kind: "plugins" | "integrations"
  busy: boolean
  installing?: string
  canConfigure?: boolean
  installed: (entry: CatalogEntry) => boolean
  onSelect: (entry: CatalogEntry) => void
}> = (props) => {
  const language = useLanguage()
  const t = language.t
  const platform = usePlatform()
  const sdk = useServerSDK()
  const api = createMemo(() => sdk().currentApi.extensions)
  const [refreshing, setRefreshing] = createSignal(false)
  const [error, setError] = createSignal("")
  const [catalog, { mutate, refetch }] = createResource(api, async (current) => {
    try {
      return await current.catalog()
    } catch (error) {
      if (api() === current) setError(error instanceof Error ? error.message : String(error))
      return undefined
    }
  })
  const [query, setQuery] = createSignal("")
  const [filter, setFilter] = createSignal("all")
  const entries = createMemo(() =>
    (catalog()?.entries ?? []).filter((e) => (e.kind === "plugin") === (props.kind === "plugins")),
  )
  const visible = createMemo(() => {
    const search = query().trim().toLocaleLowerCase()
    return entries()
      .filter((entry) => {
        if (filter() === "ready" && !installable(entry)) return false
        if (!["all", "ready"].includes(filter()) && entry.kind !== filter()) return false
        return [entry.name, entry.description, entry.descriptionZh ?? "", entry.plugin?.spec ?? "", entry.url]
          .join(" ")
          .toLocaleLowerCase()
          .includes(search)
      })
      .sort((a, b) => Number(installable(b)) - Number(installable(a)))
  })
  createEffect(() => {
    api()
    setError("")
    setQuery("")
    setFilter("all")
  })
  const refresh = async () => {
    if (refreshing()) return
    const current = api()
    setRefreshing(true)
    setError("")
    try {
      const result = await current.catalog(true)
      if (api() === current) mutate(result)
    } catch (error) {
      if (api() === current) setError(error instanceof Error ? error.message : String(error))
    } finally {
      setRefreshing(false)
    }
  }
  return (
    <section class="extension-catalog" data-testid={`extension-catalog-${props.kind}`}>
      <div class="extension-header">
        <div>
          <h3 class="settings-v2-section-title">{t("settings.extensions.officialDirectory")}</h3>
          <p class="extension-note">{t("settings.extensions.directoryScope")}</p>
        </div>
        <ButtonV2 size="small" variant="outline" disabled={refreshing()} onClick={() => void refresh()}>
          {refreshing() ? t("settings.extensions.refreshing") : t("settings.extensions.refreshDirectory")}
        </ButtonV2>
      </div>
      <Show when={catalog()}>
        {(catalog) => (
          <p class="extension-note" role="status">
            {t(`settings.extensions.catalogOrigin.${catalog().origin}`)} ·{" "}
            {new Date(catalog().fetchedAt).toLocaleString(language.locale())}
          </p>
        )}
      </Show>
      <Show when={error() || catalog.error || catalog()?.warning}>
        <p class="extension-error" role="alert">
          {t("settings.extensions.directoryUnavailable")} {error() || String(catalog.error ?? catalog()?.warning ?? "")}
        </p>
        <Show when={!catalog()}>
          <ButtonV2 size="small" variant="outline" onClick={() => void refetch()}>
            {t("settings.extensions.refresh")}
          </ButtonV2>
        </Show>
      </Show>
      <div class="extension-catalog-tools">
        <input
          type="search"
          aria-label={t("settings.extensions.searchResources")}
          placeholder={t("settings.extensions.searchResources")}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <select
          aria-label={t("settings.extensions.filterResources")}
          value={filter()}
          onChange={(e) => setFilter(e.currentTarget.value)}
        >
          <option value="all">{t("settings.extensions.allResources")}</option>
          <option value="ready">{t("settings.extensions.readyResources")}</option>
          <Show when={props.kind === "integrations"}>
            <option value="mcp">MCP</option>
            <option value="project">{t("settings.extensions.kind.project")}</option>
            <option value="agent">{t("settings.extensions.kind.agent")}</option>
          </Show>
        </select>
      </div>
      <Show when={catalog.loading}>
        <p class="extension-note" role="status">
          {t("settings.extensions.loading")}
        </p>
      </Show>
      <Show when={catalog()}>
        <p class="extension-note">
          {visible().length} / {entries().length}
        </p>
      </Show>
      <Show
        when={visible().length}
        fallback={!catalog.loading && <p class="extension-note">{t("settings.extensions.noResources")}</p>}
      >
        <div class="extension-catalog-list">
          <For each={visible()}>
            {(entry) => (
              <article class="extension-catalog-card">
                <div class="extension-header">
                  <h4>{entry.name}</h4>
                  <span class="extension-badge">
                    {entry.installation?.type === "instructions"
                      ? t("settings.extensions.instructions")
                      : t(`settings.extensions.kind.${entry.kind}`)}
                  </span>
                </div>
                <p class="extension-note">
                  {language.locale() === "zh" ? (entry.descriptionZh ?? entry.description) : entry.description}
                </p>
                <Show when={entry.plugin}>
                  {(plugin) => (
                    <p class="extension-note">
                      <span class="extension-spec">{plugin().spec}</span>
                      {t("settings.extensions.recipeVerified")} · {plugin().verifiedAt}
                    </p>
                  )}
                </Show>
                <Show when={entry.installation?.type === "files" || entry.installation?.type === "instructions"}>
                  <p class="extension-note">
                    {t("settings.extensions.sourceInstall")} · {entry.installation?.verifiedAt}
                  </p>
                </Show>
                <Show when={entry.installation?.note}>
                  <p class="extension-note">
                    {language.locale() === "zh"
                      ? (entry.installation?.noteZh ?? entry.installation?.note)
                      : entry.installation?.note}
                  </p>
                </Show>
                <Show when={entry.plugin?.spec === "opencode-wakatime"}>
                  <p class="extension-note">{t("settings.extensions.wakatimeSetup")}</p>
                </Show>
                <Show when={entry.plugin?.spec === "@tarquinen/opencode-dcp"}>
                  <p class="extension-note">{t("settings.extensions.dcpSetup")}</p>
                </Show>
                <Show when={entry.mcp}>
                  {(mcp) => (
                    <p class="extension-note">
                      <span class="extension-spec">{mcp().url}</span>
                      {mcp().oauth
                        ? t("settings.extensions.requiresAuthorization")
                        : t("settings.extensions.mcpTemplate")}
                    </p>
                  )}
                </Show>
                <Show when={!entry.installation && !entry.mcp}>
                  <p class="extension-note">
                    {entry.kind === "plugin"
                      ? t("settings.extensions.manualRecipe")
                      : t("settings.extensions.externalResource")}
                  </p>
                </Show>
                <div class="extension-catalog-footer">
                  <div class="extension-actions">
                    <ButtonV2 size="small" variant="ghost" onClick={() => platform.openExternal(entry.sourceUrl)}>
                      {t("settings.extensions.sourceDocs")}
                    </ButtonV2>
                    <ButtonV2 size="small" variant="ghost" onClick={() => platform.openExternal(entry.url)}>
                      {t("settings.extensions.projectDocs")}
                    </ButtonV2>
                  </div>
                  <Show when={entry.installation?.type === "builtin"}>
                    <span class="extension-badge">{t("settings.extensions.builtin")}</span>
                  </Show>
                  <Show when={installable(entry)}>
                    <ButtonV2
                      size="small"
                      disabled={props.busy || props.installed(entry) || (!!entry.mcp && !props.canConfigure)}
                      onClick={() => props.onSelect(entry)}
                    >
                      {props.installed(entry)
                        ? t("settings.extensions.installed")
                        : props.installing === entry.id
                          ? t("settings.extensions.working")
                          : entry.mcp
                            ? t("settings.extensions.configureIntegration")
                            : entry.installation?.type === "instructions"
                              ? t("settings.extensions.importInstructions")
                              : t("settings.extensions.install")}
                    </ButtonV2>
                  </Show>
                </div>
              </article>
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}
