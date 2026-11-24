import { createSignal } from "solid-js"
import { Button } from "@opencode/ui/button"
import { ProviderDiscovery } from "@opencode/schema/provider-discovery"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { formatServerError } from "@/runtime/server/errors"
import { showToast } from "@/shell/notifications/toast"
import { createRefreshState, refreshClaimed, transitionRefresh, type RefreshEvent } from "./refresh-machine"

/**
 * Koma: asks the server to read the model lists of configured OpenAI-compatible providers again. The lists update
 * through the server's provider events, so the page needs no reload of its own.
 */
export function RefreshModelsButton() {
  const language = useLanguage()
  const sdk = useServerSDK()
  const [state, setState] = createSignal(createRefreshState())
  let attempts = 0

  const dispatch = (event: RefreshEvent) => setState((current) => transitionRefresh(current, event))

  const refresh = async () => {
    const attempt = ++attempts

    dispatch({ type: "requested", attempt })

    if (!refreshClaimed(state(), attempt)) return

    try {
      const result = await sdk.api.rpc(ProviderDiscovery.Definition).refresh({})
      const failed = result.providers.filter((item) => item.error !== undefined)

      if (result.providers.length === 0)
        showToast({
          title: language.t("settings.models.refresh.none.title"),
          description: language.t("settings.models.refresh.none.description"),
        })
      else if (failed.length > 0)
        showToast({
          variant: "error",
          title: language.t("settings.models.refresh.failed.title"),
          description: failed.map((item) => `${item.providerID}: ${item.error}`).join("\n"),
        })
      else showToast({ variant: "success", title: language.t("settings.models.refresh.done.title") })
    } catch (error) {
      showToast({ title: language.t("common.requestFailed"), description: formatServerError(error, language.t) })
    } finally {
      dispatch({ type: "settled", attempt })
    }
  }

  return (
    <Button
      type="button"
      size="normal"
      variant={state().status === "refreshing" ? "loading" : "ghost-muted"}
      data-action="settings-models-refresh"
      disabled={state().status === "refreshing"}
      onClick={() => void refresh()}
    >
      {language.t("settings.models.refresh")}
    </Button>
  )
}
