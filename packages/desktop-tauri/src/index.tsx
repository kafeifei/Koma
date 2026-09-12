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
import { desktopStorage } from "./storage"

type Connection = { pid: number; version?: string; url: string; username: string; password: string; profile: string }
const root = document.getElementById("root")!
root.textContent = "正在启动 Koma 后端…"

async function start() {
  const connection = await invoke<Connection>("initialize")
  const preferences = await invoke<Record<string, Record<string, string>>>("desktop_preferences")
  platform.storage = desktopStorage(connection.profile, preferences)
  const language = await platform.storage("opencode.global.dat").getItem("language")
  const locale = normalizeLocale((language && JSON.parse(language).locale) || navigator.language)
  if (locale !== "en") await loadLocaleDict(locale)
  const server: ServerConnection.Any = {
    type: "sidecar",
    variant: "base",
    displayName: "Koma 本地后端",
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
  console.info("Koma Tauri connected", {
    profile: connection.profile,
    pid: connection.pid,
    version: connection.version,
    url: connection.url,
  })
}

void start().catch((error) => {
  root.textContent = `Koma 后端启动失败：${String(error)}。日志位于 Koma 数据目录的 bin/.koma-instances/tauri/service.log。`
  console.error(error)
})
