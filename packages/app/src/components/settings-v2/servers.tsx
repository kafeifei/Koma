import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import fuzzysort from "fuzzysort"
import { type Component, For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { ServerRowMenu } from "@/components/server/server-row-menu"
import { ServerHealthIndicator } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { ServerConnection, serverName } from "@/context/server"
import { useServerManagementController } from "../dialog-select-server"
import { DialogServerV2 } from "./dialog-server-v2"
import { SettingsListV2 } from "./parts/list"
import { AddServerMenu, isWslServer, useFilteredWslServers, WslServerSettings } from "@/wsl/settings"
import "./settings-v2.css"

export const SettingsServersV2: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const controller = useServerManagementController({ onSelect: dialog.close })
  const [store, setStore] = createStore({ filter: "" })
  const wslServers = useFilteredWslServers(() => store.filter)

  const showSearch = createMemo(
    () => controller.sortedItems().filter((item) => !isWslServer(item)).length + wslServers().length > 1,
  )

  const filtered = createMemo(() => {
    const items = controller.sortedItems().filter((item) => !isWslServer(item))
    const query = store.filter.trim()
    if (!query) return items
    return fuzzysort
      .go(query, items, {
        keys: [(item) => serverName(item), (item) => item.http.url],
      })
      .map((result) => result.obj)
  })

  const openAdd = () => {
    dialog.push(() => <DialogServerV2 mode="add" />)
  }

  const openEdit = (server: ServerConnection.Http) => {
    dialog.push(() => <DialogServerV2 mode="edit" server={server} />)
  }

  const builtins = createMemo(() =>
    controller.sortedItems().filter((item) => ServerConnection.builtin(item) && !isWslServer(item)),
  )
  const saved = createMemo(() => filtered().filter((item) => !ServerConnection.builtin(item)))
  const Rows: Component<{ items: ServerConnection.Any[] }> = (props) => (
    <For each={props.items}>
      {(item) => {
        const key = ServerConnection.key(item)
        const health = () => controller.status()[key]
        return (
          <div class="settings-v2-servers-row">
            <div class="settings-v2-servers-lead">
              <ServerHealthIndicator health={health()} />
              <div class="settings-v2-servers-copy">
                <span class="settings-v2-servers-name">{serverName(item)}</span>
                <span class="settings-v2-servers-url">{item.http.url}</span>
                <Show when={health()?.version}>
                  <span class="settings-v2-servers-meta">v{health()?.version}</span>
                </Show>
              </div>
            </div>
            <div class="settings-v2-servers-actions">
              <Show when={ServerConnection.builtin(item)}>
                <Tag>{language.t("settings.connections.builtin")}</Tag>
              </Show>
              <Show when={controller.canDefault() && controller.defaultKey() === key}>
                <Tag>{language.t("dialog.server.status.default")}</Tag>
              </Show>
              <ButtonV2
                variant="neutral"
                disabled={health()?.healthy === false}
                onClick={() => void controller.select(item)}
              >
                {language.t("settings.connections.openProjects")}
              </ButtonV2>
              <ServerRowMenu server={item} controller={controller} onEdit={openEdit} />
            </div>
          </div>
        )
      }}
    </For>
  )
  return (
    <section class="settings-v2-section settings-v2-connection-servers">
      <Show when={builtins().length}>
        <div class="settings-v2-connection-subheading">
          <h3>{language.t("settings.connections.local")}</h3>
        </div>
        <SettingsListV2>
          <Rows items={builtins()} />
        </SettingsListV2>
      </Show>
      <div class="settings-v2-connection-subheading">
        <div class="settings-v2-connection-heading">
          <h3>{language.t("settings.connections.saved")}</h3>
          <p>{language.t("settings.connections.saved.description")}</p>
        </div>
        <AddServerMenu onAddServer={openAdd} />
      </div>
      <Show when={showSearch()}>
        <TextInputV2
          class="!w-full"
          type="search"
          appearance="base"
          value={store.filter}
          onInput={(event) => setStore("filter", event.currentTarget.value)}
          showClearButton={!!store.filter}
          clearLabel={language.t("common.clear")}
          onClearClick={() => setStore("filter", "")}
          placeholder={language.t("dialog.server.search.placeholder")}
          aria-label={language.t("dialog.server.search.placeholder")}
          spellcheck={false}
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
        />
      </Show>
      <Show
        when={saved().length || wslServers().length}
        fallback={
          <div class="settings-v2-servers-status">
            {store.filter ? language.t("palette.empty") : language.t("dialog.server.empty")}
          </div>
        }
      >
        <SettingsListV2>
          <WslServerSettings controller={controller} servers={wslServers} />
          <Rows items={saved()} />
        </SettingsListV2>
      </Show>
    </section>
  )
}
