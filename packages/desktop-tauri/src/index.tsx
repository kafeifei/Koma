// @refresh reload
import { render } from "solid-js/web"
import { onCleanup } from "solid-js"
import { MemoryRouter } from "@solidjs/router"
import { invoke } from "@tauri-apps/api/core"
import {
  AppBaseProviders,
  AppInterface,
  PlatformProvider,
  ServerConnection,
  loadLocaleDict,
  normalizeLocale,
} from "@opencode-ai/app"
import { platform } from "./platform"
import { watchWindowState } from "./window-state"
import { watchTitlebarDragRegions } from "./titlebar"

type Connection = { url: string; username: string; password: string; profile: string }
const root = document.getElementById("root")!
root.textContent = "正在启动 Tauri 测试后端…"

async function start() {
  const connection = await invoke<Connection>("initialize")
  const locale = normalizeLocale(navigator.language)
  if (locale !== "en") await loadLocaleDict(locale)
  const server: ServerConnection.Any = {
    type: "sidecar",
    variant: "base",
    displayName: "Tauri 测试后端",
    http: { url: connection.url, username: connection.username, password: connection.password },
  }
  root.textContent = ""
  render(() => {
    onCleanup(watchWindowState())
    onCleanup(watchTitlebarDragRegions())
    return (
      <PlatformProvider value={platform}>
        <AppBaseProviders locale={locale}>
          <AppInterface defaultServer={ServerConnection.key(server)} servers={[server]} router={MemoryRouter} />
        </AppBaseProviders>
      </PlatformProvider>
    )
  }, root)
  console.info("Tauri test UI mounted", { profile: connection.profile })
}

void start().catch((error) => {
  root.textContent = `测试后端启动失败：${String(error)}。日志位于本 worktree 的 .local/desktop-tests/tauri/profile/bin/.lab-backend/service.log。`
  console.error(error)
})
