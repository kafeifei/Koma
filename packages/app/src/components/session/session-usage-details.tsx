import { For, Show } from "solid-js"
import type { ProviderUsageInfo, ProviderUsageWindow } from "@opencode-ai/sdk/v2/client"
import { useLanguage } from "@/context/language"
import type { SessionUsageMetrics } from "./session-usage-metrics"

export function SessionUsageDetails(props: {
  metrics: SessionUsageMetrics
  account?: ProviderUsageInfo | null
  providerName?: string
}) {
  const language = useLanguage()
  const number = (value: number) => value.toLocaleString(language.intl())
  const percent = (value: number) => new Intl.NumberFormat(language.intl(), { style: "percent" }).format(value / 100)
  const duration = (seconds?: number) => {
    if (!seconds) return
    const [amount, unit] =
      seconds % 86400 === 0
        ? [seconds / 86400, "day"]
        : seconds % 3600 === 0
          ? [seconds / 3600, "hour"]
          : seconds % 60 === 0
            ? [seconds / 60, "minute"]
            : [seconds, "second"]
    return new Intl.NumberFormat(language.intl(), { style: "unit", unit: unit as string, unitDisplay: "long" }).format(
      amount as number,
    )
  }
  const windowName = (window: ProviderUsageWindow) =>
    [window.name, duration(window.durationSeconds)].filter(Boolean).join(" · ") || language.t("context.usage.limit")
  const reset = (timestamp: number) =>
    new Intl.DateTimeFormat(language.intl(), {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(timestamp)

  const bar = (value: number) => (
    <div class="h-1 w-full overflow-hidden rounded-full bg-v2-background-bg-layer-04" aria-hidden="true">
      <div
        class="h-full rounded-full bg-v2-icon-icon-base"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  )

  return (
    <Show
      when={props.metrics.percent !== undefined || props.metrics.cost !== undefined || props.account}
      fallback={language.t("context.usage.view")}
    >
      <div
        class="flex w-64 max-w-[calc(100vw-32px)] flex-col gap-3 p-2 text-12 leading-normal"
        data-component="session-usage-details"
      >
        <Show when={props.metrics.percent !== undefined}>
          <div class="flex flex-col gap-2" data-section="context">
            <div class="flex items-center justify-between gap-4">
              <span>{language.t("context.usage.contextWindow")}</span>
              <span>
                {percent(props.metrics.percent!)} {language.t("context.usage.used")}
              </span>
            </div>
            {bar(props.metrics.percent!)}
            <div class="text-v2-text-text-muted">
              {language.t("context.usage.tokenRange", {
                used: number(props.metrics.current!),
                limit: number(props.metrics.limit!),
              })}
            </div>
          </div>
        </Show>
        <Show when={props.metrics.cost !== undefined}>
          <div class="flex items-center justify-between gap-4" data-section="cost">
            <span class="text-v2-text-text-muted">{language.t("context.usage.sessionCost")}</span>
            <span>
              {new Intl.NumberFormat(language.intl(), {
                style: "currency",
                currency: "USD",
                maximumFractionDigits: 4,
              }).format(props.metrics.cost!)}
            </span>
          </div>
        </Show>
        <Show when={props.account} keyed>
          {(account) => (
            <div
              class="flex flex-col gap-3"
              classList={{
                "border-t border-v2-border-border-muted pt-3":
                  props.metrics.percent !== undefined || props.metrics.cost !== undefined,
              }}
              data-section="account"
            >
              <div class="flex items-center justify-between gap-4">
                <span>{props.providerName ?? account.providerID}</span>
                <Show when={account.plan}>
                  <span class="text-v2-text-text-muted">{account.plan}</span>
                </Show>
              </div>
              <For each={account.windows}>
                {(window) => (
                  <div class="flex flex-col gap-1.5">
                    <div class="flex items-center justify-between gap-4">
                      <span class="min-w-0">{windowName(window)}</span>
                      <Show when={window.usedPercent !== undefined}>
                        <span class="shrink-0">
                          {percent(window.usedPercent!)} {language.t("context.usage.used")}
                        </span>
                      </Show>
                    </div>
                    <Show when={window.usedPercent !== undefined}>{bar(window.usedPercent!)}</Show>
                    <Show when={window.resetsAt !== undefined}>
                      <span class="text-v2-text-text-muted">
                        {language.t("context.usage.resets", { time: reset(window.resetsAt!) })}
                      </span>
                    </Show>
                  </div>
                )}
              </For>
              <Show when={account.unlimitedCredits || account.credits !== undefined}>
                <div class="flex items-center justify-between gap-4">
                  <span class="text-v2-text-text-muted">{language.t("context.usage.credits")}</span>
                  <span>
                    {account.unlimitedCredits ? language.t("context.usage.unlimited") : number(account.credits!)}
                  </span>
                </div>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </Show>
  )
}
