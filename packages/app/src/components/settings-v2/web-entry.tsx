import { Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import type { WebEntryPlatform, WebEntryState } from "@/web-entry"
import { SettingsRowV2 } from "./parts/row"
import { SettingsListV2 } from "./parts/list"

export function WebEntrySetting(props: { entry: WebEntryPlatform }) {
  const language = useLanguage()
  const platform = usePlatform()
  const [store, setStore] = createStore<{ state?: WebEntryState; pending: boolean }>({ pending: true })
  const update = (state: WebEntryState) => setStore({ state, pending: false })

  onMount(() => {
    onCleanup(props.entry.subscribe(update))
    void props.entry.getState().then(update)
  })

  const toggle = async (enabled: boolean) => {
    setStore("pending", true)
    const state = await props.entry.setEnabled(enabled).catch(() => ({ enabled, url: null, error: true }))
    update(state)
  }

  return (
    <SettingsListV2>
      <SettingsRowV2
        title={language.t("settings.webEntry.title")}
        description={
          <div class="flex flex-col gap-1">
            <span>{language.t("settings.webEntry.description")}</span>
            <Show when={store.state?.url}>
              {(url) => (
                <a
                  class="font-mono text-v2-text-text-strong underline select-text"
                  href={url()}
                  onClick={(event) => {
                    event.preventDefault()
                    platform.openExternal(url())
                  }}
                >
                  {url()}
                </a>
              )}
            </Show>
            <Show when={store.state?.error}>
              <span role="alert">{language.t("settings.webEntry.error")}</span>
            </Show>
          </div>
        }
      >
        <Switch hideLabel checked={store.state?.enabled ?? true} disabled={store.pending} onChange={toggle}>
          {language.t("settings.webEntry.title")}
        </Switch>
      </SettingsRowV2>
    </SettingsListV2>
  )
}
