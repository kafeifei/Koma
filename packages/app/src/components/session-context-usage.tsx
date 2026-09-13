import { Match, Show, Switch, createMemo, createResource, createSignal, type ComponentProps } from "solid-js"
import { ProgressCircle } from "@opencode-ai/ui/progress-circle"
import { ProgressCircleV2 } from "@opencode-ai/ui/v2/progress-circle-v2"
import { Button } from "@opencode-ai/ui/button"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { createMediaQuery } from "@solid-primitives/media"

import { useFile } from "@/context/file"
import { useLayout } from "@/context/layout"
import { useSync } from "@/context/sync"
import { useServerSync } from "@/context/server-sync"
import { getSessionUsageMetrics } from "@/components/session/session-usage-metrics"
import { SessionUsageDetails } from "@/components/session/session-usage-details"
import { useLanguage } from "@/context/language"
import { useProviders } from "@/hooks/use-providers"
import { useSDK } from "@/context/sdk"
import { useSessionLayout } from "@/pages/session/session-layout"
import { createSessionTabs } from "@/pages/session/helpers"
import { useSettings } from "@/context/settings"

interface SessionContextUsageProps {
  variant?: "button" | "indicator"
  buttonAppearance?: "default" | "v2"
  placement?: ComponentProps<typeof TooltipV2>["placement"]
}

function openSessionContext(args: {
  view: ReturnType<ReturnType<typeof useLayout>["view"]>
  layout: ReturnType<typeof useLayout>
  tabs: ReturnType<ReturnType<typeof useLayout>["tabs"]>
  workspace: boolean
}) {
  const panel = args.workspace ? args.view.workspacePanel : args.view.reviewPanel
  panel.open(panel.opened() ? "other" : "context-button")
  if (!args.workspace && args.layout.fileTree.opened() && args.layout.fileTree.tab() !== "all")
    args.layout.fileTree.setTab("all")
  void args.tabs.open("context")
  args.tabs.setActive("context")
}

export function SessionContextUsage(props: SessionContextUsageProps) {
  const sync = useSync()
  const serverSync = useServerSync()
  const file = useFile()
  const layout = useLayout()
  const language = useLanguage()
  const sdk = useSDK()
  const settings = useSettings()
  const providers = useProviders(() => sdk().directory)
  const { params, tabs, view } = useSessionLayout()
  const external = () => !!params.id && serverSync().external.isExternal(params.id)
  const isDesktop = createMediaQuery("(min-width: 768px)")

  const variant = createMemo(() => props.variant ?? "button")
  const buttonAppearance = createMemo(() => props.buttonAppearance ?? "default")
  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab: (tab) => (tab.startsWith("file://") ? file.tab(tab) : tab),
    fileBrowser: () => settings.general.newLayoutDesigns() && isDesktop() && !!params.id,
    sidePanel: () => settings.general.newLayoutDesigns() && isDesktop() && !!params.id,
  })
  const messages = createMemo(() => (params.id ? (sync().data.message[params.id] ?? []) : []))
  const info = createMemo(() => (params.id ? sync().session.get(params.id) : undefined))

  const metrics = createMemo(() =>
    getSessionUsageMetrics({
      external: external(),
      snapshot: params.id ? serverSync().external.data.snapshots[params.id] : undefined,
      model: params.id ? serverSync().external.data.descriptors[params.id]?.settings.model : undefined,
      engines: serverSync().external.data.engines,
      messages: messages(),
      providers: [...providers.all().values()],
      cost: info()?.cost,
    }),
  )
  const [inspecting, setInspecting] = createSignal(false)
  const providerID = createMemo(() => metrics().providerID)
  const [account] = createResource(
    () => inspecting() && !!providerID() && { client: sdk().client, providerID: providerID()! },
    async ({ client, providerID }) => {
      const result = await client.provider
        .usage({ providerID }, { signal: AbortSignal.timeout(12000) })
        .catch(() => undefined)
      return result?.data?.usage
    },
  )
  const usage = () => metrics().percent
  const workspace = () => settings.general.newLayoutDesigns() && isDesktop() && !!params.id
  const panel = () => (workspace() ? view().workspacePanel : view().reviewPanel)
  const contextVisible = createMemo(() => panel().opened() && tabState.activeTab() === "context")
  const hasOtherTabs = createMemo(() =>
    tabs()
      .all()
      .some((tab) => tab !== "context" && tab !== "review"),
  )

  const openContext = () => {
    if (!params.id) return

    const sessionView = view()
    if (contextVisible()) {
      tabs().close("context")
      if (panel().source() === "context-button" && !hasOtherTabs()) panel().close()
      return
    }

    openSessionContext({
      view: sessionView,
      layout,
      tabs: tabs(),
      workspace: workspace(),
    })
  }

  const circle = () => (
    <ProgressCircle
      size={16}
      strokeWidth={2}
      percentage={usage() ?? 0}
      style={
        variant() === "indicator"
          ? {
              "--progress-circle-background": "var(--v2-background-bg-layer-04, var(--border-weak-base))",
              "--progress-circle-progress": "var(--v2-icon-icon-base, var(--icon-base))",
            }
          : undefined
      }
    />
  )
  const circleV2 = () => <ProgressCircleV2 percentage={usage() ?? 0} />

  const tooltipValue = () => (
    <SessionUsageDetails
      metrics={metrics()}
      account={
        inspecting() && providerID() && !account.loading && account()?.providerID === providerID()
          ? account()
          : undefined
      }
      providerName={providers.all().get(metrics().providerID ?? "")?.name}
    />
  )

  return (
    <Show when={params.id && usage() !== undefined}>
      <div
        class="flex items-center"
        onPointerEnter={() => setInspecting(true)}
        onPointerLeave={() => setInspecting(false)}
        onFocusIn={() => setInspecting(true)}
        onFocusOut={() => setInspecting(false)}
      >
        <TooltipV2 value={tooltipValue()} placement={props.placement ?? "top"} shift={-8}>
          <Switch>
            <Match when={variant() === "indicator"}>{circle()}</Match>
            <Match when={buttonAppearance() === "v2"}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="large"
                icon={circleV2()}
                onClick={openContext}
                aria-label={language.t("context.usage.view")}
              />
            </Match>
            <Match when={true}>
              <Button
                type="button"
                variant="ghost"
                class="size-6"
                onClick={openContext}
                aria-label={language.t("context.usage.view")}
              >
                {circle()}
              </Button>
            </Match>
          </Switch>
        </TooltipV2>
      </div>
    </Show>
  )
}
