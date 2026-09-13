import { useServerSDK } from "@/context/server-sdk"
import { ServerConnection } from "@/context/server"
import { SettingsPluginsV2, SettingsIntegrationsV2 } from "./extensions"
import { Component, Show, createMemo, createSignal, startTransition } from "solid-js"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneralV2 } from "./general"
import { SettingsKeybinds } from "../settings-keybinds"
import { SettingsProvidersV2 } from "./providers"
import { SettingsModelsV2 } from "./models"
import "./settings-v2.css"
import { SettingsConnectionsV2 } from "./connections"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLayout } from "@/context/layout"
import { useTabs } from "@/context/tabs"
import { useServerSync } from "@/context/server-sync"
import { BuildInfo } from "../build-info"
import { SettingsExperiments } from "../settings-experiments"
import { SettingsComputerUse } from "./computer-use"
import { SettingsPanelV2 } from "./parts/panel"

export const DialogSettings: Component<{
  sessionID?: string
  defaultValue?: string
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()
  const dialog = useDialog()
  const layout = useLayout()
  const tabs = useTabs()
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const initialTab =
    props.defaultValue === "remote" || props.defaultValue === "servers" ? "connections" : props.defaultValue
  const [tab, setTab] = createSignal(initialTab ?? "general")
  const directory = createMemo(() => {
    const route = layout.route()
    if (route.type === "home") {
      const selection = layout.home.selection()
      return selection.server === ServerConnection.key(serverSDK().server) ? selection.directory : undefined
    }
    if (route.type === "dir-new-sesssion") return route.dir
    if (route.type === "draft") {
      const draft = tabs.store.find((item) => item.type === "draft" && item.draftID === route.draftID)
      return draft?.type === "draft" ? draft.directory : undefined
    }
    if (route.type === "session") return serverSync().session.get(route.sessionId)?.directory
    return undefined
  })

  const showProviders = () => {
    void dialog.show(() => <DialogSettings sessionID={props.sessionID} defaultValue="providers" />)
  }

  return (
    <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
      <TabsV2
        orientation="vertical"
        variant="settings"
        value={tab()}
        onChange={(value) => void startTransition(() => setTab(value))}
        class="settings-v2"
      >
        <TabsV2.List>
          <div class="flex flex-col justify-between h-full w-full">
            <div class="flex flex-col gap-3 w-full">
              <div class="flex flex-col gap-3">
                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>{language.t("settings.section.desktop")}</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger value="general">
                      <Icon name="sliders" />
                      {language.t("settings.tab.general")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="shortcuts">
                      <Icon name="keyboard" />
                      {language.t("settings.tab.shortcuts")}
                    </TabsV2.Trigger>
                    <Show when={import.meta.env.OPENCODE_BUILD?.channel === "lab"}>
                      <TabsV2.Trigger value="computer-use">
                        <Icon name="window-cursor" />
                        {language.t("settings.computerUse.title")}
                      </TabsV2.Trigger>
                    </Show>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>{language.t("settings.section.server")}</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger value="connections">
                      <Icon name="link" />
                      {language.t("settings.tab.connections")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="providers">
                      <Icon name="providers" />
                      {language.t("settings.providers.title")}
                    </TabsV2.Trigger>
                    <TabsV2.Trigger value="models">
                      <Icon name="models" />
                      {language.t("settings.models.title")}
                    </TabsV2.Trigger>
                    <Show when={platform.backendExperiments}>
                      <TabsV2.Trigger value="experiments">
                        <Icon name="sliders" />
                        {language.t("settings.experiments.title")}
                      </TabsV2.Trigger>
                    </Show>
                  </div>
                </div>
                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>{language.t("settings.extensions.section")}</TabsV2.SectionTitle>
                  <TabsV2.Trigger value="plugins">
                    <Icon name="providers" />
                    {language.t("settings.extensions.plugins")}
                  </TabsV2.Trigger>
                  <TabsV2.Trigger value="integrations">
                    <Icon name="server" />
                    {language.t("settings.extensions.integrations")}
                  </TabsV2.Trigger>
                </div>
              </div>
            </div>
            <div class="settings-v2-nav-footer">
              <span>{language.t("app.name.desktop")}</span>
              <span>
                v{platform.version}
                {platform.buildInfo?.sequence ? ` #${platform.buildInfo.sequence}` : ""}
              </span>
              <BuildInfo />
            </div>
          </div>
        </TabsV2.List>
        <SettingsPanelV2 value="general">
          <SettingsGeneralV2 sessionID={props.sessionID} />
        </SettingsPanelV2>
        <SettingsPanelV2 value="shortcuts">
          <SettingsKeybinds v2 />
        </SettingsPanelV2>
        <SettingsPanelV2 value="connections">
          <SettingsConnectionsV2 initialSection={props.defaultValue} />
        </SettingsPanelV2>
        <Show when={tab() === "computer-use" && import.meta.env.OPENCODE_BUILD?.channel === "lab"}>
          <SettingsPanelV2 value="computer-use">
            <SettingsComputerUse />
          </SettingsPanelV2>
        </Show>
        <SettingsPanelV2 value="providers">
          <SettingsProvidersV2 directory={directory} onBack={showProviders} />
        </SettingsPanelV2>
        <SettingsPanelV2 value="plugins">
          <SettingsPluginsV2 />
        </SettingsPanelV2>
        <SettingsPanelV2 value="integrations">
          <SettingsIntegrationsV2 directory={directory} />
        </SettingsPanelV2>
        <SettingsPanelV2 value="models">
          <SettingsModelsV2 />
        </SettingsPanelV2>
        <Show when={platform.backendExperiments}>
          {(experiments) => (
            <SettingsPanelV2 value="experiments">
              <SettingsExperiments experiments={experiments()} />
            </SettingsPanelV2>
          )}
        </Show>
      </TabsV2>
    </Dialog>
  )
}
