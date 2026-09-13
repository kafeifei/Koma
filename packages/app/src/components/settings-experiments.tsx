import { Show, Suspense, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Switch } from "@opencode-ai/ui/switch"
import type { BackendExperimentsPlatform } from "@/backend-experiments"
import { useLanguage } from "@/context/language"

export function SettingsExperiments(props: { experiments: BackendExperimentsPlatform }) {
  const language = useLanguage()
  // Dialogs inherit the page owner. Keep this request from suspending the workspace behind them.
  return (
    <Suspense
      fallback={
        <div class="p-6 text-12-regular text-text-weak" role="status">
          {language.t("common.loading")}
        </div>
      }
    >
      <SettingsExperimentsContent experiments={props.experiments} />
    </Suspense>
  )
}

function SettingsExperimentsContent(props: { experiments: BackendExperimentsPlatform }) {
  const language = useLanguage()
  const [state, setState] = createStore({ saving: false, failed: false })
  const [settings, { mutate, refetch }] = createResource(async () => {
    setState("failed", false)
    return props.experiments.getState().catch(() => {
      setState("failed", true)
      return undefined
    })
  })
  const change = async (enabled: boolean) => {
    if (state.saving) return
    setState({ saving: true, failed: false })
    try {
      mutate(await props.experiments.setBackgroundSubagents(enabled))
    } catch {
      setState("failed", true)
    } finally {
      setState("saving", false)
    }
  }

  return (
    <div class="flex flex-col gap-6 p-6" data-component="settings-experiments">
      <div class="flex flex-col gap-2">
        <h2 class="text-16-medium text-text-strong">{language.t("settings.experiments.title")}</h2>
        <p class="text-12-regular text-text-weak">{language.t("settings.experiments.scope")}</p>
      </div>
      <div class="flex items-start justify-between gap-4 rounded-lg bg-surface-base p-4">
        <div class="flex min-w-0 flex-col gap-2">
          <span class="text-14-medium text-text-strong">{language.t("settings.experiments.background.title")}</span>
          <p class="text-12-regular text-text-weak">{language.t("settings.experiments.background.description")}</p>
          <Show when={settings()}>
            {(value) => (
              <>
                <p class="text-12-regular text-text-weak" data-slot="experiment-active">
                  {language.t(
                    value().runningBackgroundSubagents === null
                      ? "settings.experiments.unknown"
                      : value().runningBackgroundSubagents
                        ? "settings.experiments.enabled"
                        : "settings.experiments.disabled",
                  )}
                </p>
                <Show
                  when={
                    value().runningBackgroundSubagents !== null &&
                    value().backgroundSubagents !== value().runningBackgroundSubagents
                  }
                >
                  <p class="text-12-regular text-text-strong" role="status">
                    {language.t("settings.experiments.restart")}
                  </p>
                </Show>
              </>
            )}
          </Show>
        </div>
        <Switch
          aria-label={language.t("settings.experiments.background.title")}
          checked={settings()?.backgroundSubagents ?? false}
          disabled={!settings() || settings.loading || state.saving}
          onChange={(enabled) => void change(enabled)}
        />
      </div>
      <Show when={state.failed}>
        <div class="flex items-center gap-3" role="alert">
          <span class="text-12-regular text-text-weak">{language.t("common.requestFailed")}</span>
          <Button onClick={() => void refetch()}>{language.t("common.retry")}</Button>
        </div>
      </Show>
    </div>
  )
}
