import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { useLanguage } from "@/context/language"
import type { RemoteAccessState, RemoteCleanupResult } from "@/remote-access"

export function DialogRemoteCleanup(props: {
  remove: (ids: string[]) => Promise<RemoteCleanupResult>
  state: () => RemoteAccessState | undefined
  selected?: string
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const snapshot = new Map(props.state()?.devices.map((device) => [device.id, device]))
  const [selected, setSelected] = createSignal<string[]>(props.selected ? [props.selected] : [])
  const [busy, setBusy] = createSignal(false)
  const [result, setResult] = createSignal<RemoteCleanupResult>()
  const [error, setError] = createSignal(false)
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const candidates = createMemo(
    () =>
      props
        .state()
        ?.devices.filter(
          (device) =>
            !device.current &&
            !device.connected &&
            device.online === false &&
            (!props.selected || props.selected === device.id),
        ) ?? [],
  )
  const eligible = createMemo(() => selected().filter((id) => candidates().some((device) => device.id === id)))
  const failures = () =>
    result()?.results.filter((item) => item.status !== "deleted" && item.status !== "missing") ?? []
  const removed = () =>
    result()?.results.filter((item) => item.status === "deleted" || item.status === "missing").length ?? 0
  const remove = async () => {
    if (busy() || !eligible().length || props.state()?.devicesError) return
    setBusy(true)
    setError(false)
    const response = await props.remove(eligible()).catch(() => undefined)
    if (disposed) return
    setBusy(false)
    if (!response) {
      setError(true)
      return
    }
    setResult(response)
    setSelected([])
  }
  const reason = (status: RemoteCleanupResult["results"][number]["status"]) => {
    if (status === "online") return language.t("settings.remote.cleanup.online")
    if (status === "unknown") return language.t("settings.remote.cleanup.unknown")
    if (status === "protected") return language.t("settings.remote.cleanup.protected")
    return language.t("settings.remote.cleanup.failed")
  }
  return (
    <Dialog fit class="settings-v2-cleanup-dialog">
      <DialogHeader>
        <DialogTitle>{language.t("settings.remote.cleanup.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="settings-v2-cleanup-body">
        <p>{language.t("settings.remote.cleanup.description")}</p>
        <Show when={error()}>
          <p class="settings-v2-remote-alert" role="alert">
            {language.t("settings.remote.error.action")}
          </p>
        </Show>
        <Show when={result()}>
          <p role="status">{language.t("settings.remote.cleanup.result", { count: removed() })}</p>
        </Show>
        <For each={failures()}>
          {(item) => (
            <p role="alert" class="settings-v2-cleanup-failure">
              {snapshot.get(item.id)?.name ?? item.id} · {reason(item.status)}
            </p>
          )}
        </For>
        <Show
          when={!props.state()?.devicesError}
          fallback={<p role="alert">{language.t("settings.remote.cleanup.refreshRequired")}</p>}
        >
          <Show when={candidates().length} fallback={<p>{language.t("settings.remote.cleanup.empty")}</p>}>
            <div class="settings-v2-connection-subheading">
              <span>{language.t("settings.remote.cleanup.candidates", { count: candidates().length })}</span>
              <ButtonV2
                variant="ghost-muted"
                disabled={busy()}
                onClick={() =>
                  setSelected(eligible().length === candidates().length ? [] : candidates().map((device) => device.id))
                }
              >
                {language.t("settings.remote.cleanup.selectAll")}
              </ButtonV2>
            </div>
            <For each={candidates()}>
              {(device) => (
                <CheckboxV2
                  label={device.name}
                  description={device.id}
                  checked={selected().includes(device.id)}
                  disabled={busy()}
                  onChange={(checked) =>
                    setSelected((items) => (checked ? [...items, device.id] : items.filter((id) => id !== device.id)))
                  }
                />
              )}
            </For>
          </Show>
        </Show>
        <p>{language.t("settings.remote.cleanup.scope")}</p>
      </DialogBody>
      <div class="settings-v2-cleanup-consequence">{language.t("settings.remote.cleanup.consequence")}</div>
      <DialogFooter>
        <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
          {result() && !candidates().length ? language.t("common.close") : language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2
          variant="danger"
          disabled={busy() || !eligible().length || !!props.state()?.devicesError}
          onClick={() => void remove()}
        >
          {busy()
            ? language.t("settings.remote.cleanup.removing")
            : language.t("settings.remote.cleanup.remove", { count: eligible().length })}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
