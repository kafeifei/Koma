import { createSignal, onCleanup, Show } from "solid-js"
import "./startup-screen.css"

export type StartupStage = "backend" | "workspace" | "models" | "session" | "page"

export function startupText(locale = navigator.language) {
  return locale.startsWith("zh")
    ? {
        backend: "正在启动 Koma…",
        workspace: "正在恢复工作区…",
        models: "正在准备模型与 Agent…",
        session: "正在恢复任务…",
        page: "正在打开工作台…",
        failed: "暂时无法打开工作台",
        timeout: "准备时间比预期长，请重试，或进入工作台检查设置。",
        backendTimeout: "启动时间比预期长，请重试。",
        retry: "重试",
        details: "查看详情",
        enter: "进入工作台",
      }
    : {
        backend: "Starting Koma…",
        workspace: "Restoring your workspace…",
        models: "Preparing models and agents…",
        session: "Restoring your task…",
        page: "Opening your workspace…",
        failed: "Couldn't open the workspace",
        timeout: "Preparation is taking longer than expected. Retry, or open the workspace to check your settings.",
        backendTimeout: "Startup is taking longer than expected. Please retry.",
        retry: "Retry",
        details: "Show details",
        enter: "Open workspace",
      }
}

// Also used before the app's providers exist. Keep this independent of their
// fonts, translation loading, routing and platform APIs.
export function StartupScreen(props: {
  stage?: StartupStage
  locale?: string
  error?: string
  timeoutMs?: number
  onRetry?: () => void
  onContinue?: () => void
}) {
  const text = () => startupText(props.locale)
  const [timedOut, setTimedOut] = createSignal(false)
  if (props.timeoutMs) {
    const timer = setTimeout(() => setTimedOut(true), props.timeoutMs)
    onCleanup(() => clearTimeout(timer))
  }
  const error = () => props.error || (timedOut() ? text().backendTimeout : undefined)
  return (
    <div data-component="startup-screen" data-state={error() ? "error" : "loading"}>
      <div data-slot="startup-titlebar" data-tauri-drag-region />
      <div data-slot="startup-content">
        <div data-slot="startup-mark" aria-hidden="true">
          K
        </div>
        <div data-slot="startup-name">Koma</div>
        <div role="status" aria-live="polite" data-slot="startup-status">
          {error() ? text().failed : text()[props.stage ?? "backend"]}
        </div>
        <Show when={!error()}>
          <div data-slot="startup-spinner" aria-hidden="true" />
        </Show>
        <Show when={error()}>
          <div data-slot="startup-actions">
            <button type="button" onClick={props.onRetry ?? (() => window.location.reload())}>
              {text().retry}
            </button>
            <Show when={props.onContinue}>
              <button type="button" onClick={props.onContinue}>
                {text().enter}
              </button>
            </Show>
          </div>
          <details data-slot="startup-details">
            <summary>{text().details}</summary>
            <pre>{error()}</pre>
          </details>
        </Show>
      </div>
    </div>
  )
}
