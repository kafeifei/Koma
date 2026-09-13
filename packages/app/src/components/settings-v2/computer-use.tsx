import { Show, type Accessor } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Switch } from "@opencode-ai/ui/switch"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { usePlatform } from "@/context/platform"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import {
  computerUseStatus,
  type ComputerUseState,
  type ComputerUseAction,
} from "@opencode-ai/core/koma-computer-use-types"
import { computerUseRequest } from "@/utils/computer-use"
import { createComputerUseController } from "@/utils/computer-use-controller"

export function useComputerUse(active: Accessor<boolean> = () => true) {
  const server = useServer()
  const platform = usePlatform()
  return createComputerUseController({
    connection: () => server.current?.http,
    active,
    request: (connection, action) => computerUseRequest(connection, action, platform.fetch ?? fetch),
  })
}

export function SettingsComputerUse() {
  const control = useComputerUse()
  return (
    <ComputerUseView
      state={control.state()}
      pending={control.pending()}
      error={control.error()}
      onAction={(action) => void control.action(action)}
      onRefresh={() => void control.refetch()}
    />
  )
}

export function ComputerUseView(props: {
  state?: ComputerUseState
  pending?: boolean
  error?: string
  onAction: (action: ComputerUseAction) => void
  onRefresh: () => void
}) {
  const language = useLanguage()
  const t = language.t
  const blocked = () => props.pending || !!props.state?.busy
  const status = () => (props.state ? computerUseStatus(props.state) : "loading")
  const permission = (value: boolean | null | undefined) =>
    t(
      value === true
        ? "settings.computerUse.granted"
        : value === false
          ? "settings.computerUse.notGranted"
          : "settings.computerUse.unknown",
    )
  return (
    <div class="flex flex-col gap-6 p-6" data-component="settings-computer-use">
      <div class="flex flex-col gap-2">
        <h2 class="text-16-medium text-text-strong">{t("settings.computerUse.title")}</h2>
        <p class="text-12-regular text-text-weak">{t("settings.computerUse.description")}</p>
      </div>
      <Show
        when={props.state}
        fallback={<p class="text-12-regular text-text-weak">{t("settings.computerUse.loading")}</p>}
      >
        {(state) => (
          <>
            <div class="flex items-start justify-between gap-4 rounded-lg bg-surface-base p-4">
              <div class="flex flex-col gap-2">
                <span class="text-14-medium text-text-strong">{t("settings.computerUse.enable")}</span>
                <p class="text-12-regular text-text-weak">{t("settings.computerUse.scope")}</p>
              </div>
              <Switch
                aria-label={t("settings.computerUse.enable")}
                checked={state().enabled}
                disabled={
                  blocked() ||
                  !state().supported ||
                  (!state().enabled &&
                    (!state().running ||
                      state().accessibility !== true ||
                      state().screenRecording !== true ||
                      !!state().error))
                }
                onChange={(enabled) => props.onAction({ action: "enable", enabled })}
              />
            </div>
            <div class="flex flex-col gap-4 rounded-lg border border-border-weak-base p-4">
              <div class="flex items-center justify-between gap-4">
                <span class="text-14-medium text-text-strong">{t("settings.computerUse.device")}</span>
                <span class="text-12-regular text-text-base break-all">{state().device}</span>
              </div>
              <div class="flex items-center justify-between gap-4">
                <span class="text-14-medium text-text-strong">
                  Cua Driver {state().version ? `v${state().version}` : ""}
                </span>
                <span class="text-12-regular text-text-weak" role="status">
                  {t(`settings.computerUse.${status()}` as "settings.computerUse.loading")}
                </span>
              </div>
              <Show when={state().supported}>
                <div class="flex flex-wrap gap-2">
                  <Show when={!state().installed}>
                    <Button
                      variant="primary"
                      disabled={blocked()}
                      onClick={() => props.onAction({ action: "install" })}
                    >
                      {t("settings.computerUse.install")}
                    </Button>
                  </Show>
                  <Show when={state().installed && !state().running}>
                    <Button
                      variant="secondary"
                      disabled={blocked()}
                      onClick={() => props.onAction({ action: "start" })}
                    >
                      {t("settings.computerUse.start")}
                    </Button>
                  </Show>
                  <Button variant="ghost" disabled={blocked()} onClick={props.onRefresh}>
                    {t("settings.computerUse.refresh")}
                  </Button>
                </div>
              </Show>
            </div>
            <Show when={state().supported && state().installed}>
              <div class="flex flex-col gap-4 rounded-lg border border-border-weak-base p-4">
                <h3 class="text-14-medium text-text-strong">{t("settings.computerUse.permissionsTitle")}</h3>
                <div class="flex justify-between gap-4 text-12-regular">
                  <span>{t("settings.computerUse.accessibility")}</span>
                  <span>{permission(state().accessibility)}</span>
                </div>
                <div class="flex justify-between gap-4 text-12-regular">
                  <span>{t("settings.computerUse.screenRecording")}</span>
                  <span>{permission(state().screenRecording)}</span>
                </div>
                <p class="text-12-regular text-text-weak">{t("settings.computerUse.grantDescription")}</p>
                <Button
                  class="self-start"
                  variant="secondary"
                  disabled={blocked()}
                  onClick={() => props.onAction({ action: "grant" })}
                >
                  {t("settings.computerUse.grant")}
                </Button>
              </div>
            </Show>
          </>
        )}
      </Show>
      <Show when={props.error || props.state?.error}>
        <div class="flex flex-col gap-2" role="alert">
          <p class="text-12-regular text-text-critical-base break-words">{props.error || props.state?.error}</p>
          <Button class="self-start" variant="secondary" onClick={props.onRefresh}>
            {t("common.retry")}
          </Button>
        </div>
      </Show>
    </div>
  )
}

export function ComputerUseStatusRow(props: { shown: Accessor<boolean> }) {
  const control = useComputerUse(props.shown)
  const language = useLanguage()
  const dialog = useDialog()
  return (
    <button
      type="button"
      data-component="computer-use-status"
      class="flex items-center justify-between gap-3 w-full rounded-md px-3 py-2 mb-2 bg-surface-base hover:bg-surface-raised-base-hover text-left"
      onClick={() =>
        void import("./dialog-settings-v2").then(({ DialogSettings }) =>
          dialog.show(() => <DialogSettings defaultValue="computer-use" />),
        )
      }
    >
      <span class="text-12-medium text-text-strong">{language.t("settings.computerUse.title")}</span>
      <span class="text-12-regular text-text-weak">
        {language.t(
          `settings.computerUse.${control.error() ? "error" : control.state() ? computerUseStatus(control.state()!) : "loading"}` as "settings.computerUse.loading",
        )}
      </span>
    </button>
  )
}
