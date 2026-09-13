import { Show, type Component } from "solid-js"
import { Tabs } from "@kobalte/core/tabs"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { RemoteConnectionSettings } from "./remote"
import { SettingsServersV2 } from "./servers"
import { WebEntrySetting } from "./web-entry"

export const SettingsConnectionsV2: Component<{ initialSection?: string }> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  return (
    <Tabs class="settings-v2-connection-tabs" defaultValue={props.initialSection === "remote" ? "remote" : "native"}>
      <div class="settings-v2-tab-header settings-v2-connection-heading">
        <h2 class="settings-v2-tab-title">{language.t("settings.tab.connections")}</h2>
        <p>{language.t("settings.connections.description")}</p>
        <Tabs.List class="settings-v2-connection-tab-list" aria-label={language.t("settings.tab.connections")}>
          <Tabs.Trigger value="native">{language.t("settings.connections.native")}</Tabs.Trigger>
          <Tabs.Trigger value="remote">{language.t("settings.connections.tunnel")}</Tabs.Trigger>
        </Tabs.List>
      </div>
      <Tabs.Content value="native" class="settings-v2-tab-body settings-v2-connections" forceMount>
        <SettingsServersV2 />
        <Show when={platform.webEntry}>
          {(entry) => (
            <section class="settings-v2-section">
              <h3>{language.t("settings.connections.web")}</h3>
              <WebEntrySetting entry={entry()} />
            </section>
          )}
        </Show>
        <p class="settings-v2-connection-note">{language.t("settings.connections.native.note")}</p>
      </Tabs.Content>
      <Tabs.Content value="remote" class="settings-v2-tab-body settings-v2-connections" forceMount>
        <Show
          when={platform.remoteAccess}
          fallback={<p class="settings-v2-connection-note">{language.t("settings.remote.unavailable.description")}</p>}
        >
          {(remote) => <RemoteConnectionSettings remoteAccess={remote()} />}
        </Show>
      </Tabs.Content>
    </Tabs>
  )
}
