// @refresh reload
import { render } from "solid-js/web"
import { onCleanup } from "solid-js"
import type { BaseRouterProps } from "@solidjs/router"
import { DesktopMemoryRouter } from "@opencode-ai/app/desktop/router"
import { invoke } from "@tauri-apps/api/core"
import {
  AppBaseProviders,
  AppInterface,
  PlatformProvider,
  ServerConnection,
  createDraftStore,
  loadLocaleDict,
  normalizeLocale,
} from "@opencode-ai/app"
import { platform } from "./platform"
import { watchWindowState } from "./window-state"
import { watchTitlebarDragRegions } from "./titlebar"
import { createDesktopStorage } from "@opencode-ai/app/desktop/storage"
import { installDesktopHost } from "./desktop-host"
import { createDesktopServices } from "@opencode-ai/app/desktop/services"
import { installDesktopPreferences } from "@opencode-ai/app/desktop/preferences"

type Connection = {
  pid: number
  version?: string
  url: string
  username: string
  password: string
  profile: string
  runtimeID?: string
}
const root = document.getElementById("root")!
root.textContent = "正在启动 Koma 后端…"

const initialized = invoke<Connection>("initialize")
const host = installDesktopHost(initialized)

async function start() {
  const connection = await initialized
  platform.runtimeID = connection.runtimeID ?? "tauri"
  const call = async (route: string, request: unknown): Promise<any> => {
    const response = await fetch(new URL(`/lab/desktop/${route}`, connection.url), {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${connection.username}:${connection.password}`)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    })
    if (!response.ok) throw new Error(`Desktop ${route} failed (${response.status})`)
    return response.json()
  }
  const sharedStorage = createDesktopStorage((request) => call("storage", request))
  const services = createDesktopServices((request) => call("services", request))
  platform.remoteAccess = services.remoteAccess
  platform.webEntry = services.webEntry
  platform.draftStore = createDraftStore({
    get: (key) => call("draft", { op: "get", key }),
    set: (key, value) => call("draft", { op: "set", key, value }),
    remove: (key) => call("draft", { op: "set", key, value: null }),
    putBlob: async (blob) => {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ""
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return call("draft", { op: "putBlob", data: btoa(binary) })
    },
    getBlob: async (id) => {
      const data = await call("draft", { op: "getBlob", id })
      return data ? new Blob([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))]) : null
    },
  })
  const getExperiments = async (enabled?: boolean) => {
    const saved = await call("experiments", { enabled })
    const running = await fetch(new URL("/experimental/capabilities", connection.url), {
      headers: { Authorization: `Basic ${btoa(`${connection.username}:${connection.password}`)}` },
      signal: AbortSignal.timeout(3000),
    })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)
    return {
      backgroundSubagents: saved.backgroundSubagents ?? running?.backgroundSubagents ?? true,
      runningBackgroundSubagents: running?.backgroundSubagents ?? null,
    }
  }
  platform.backendExperiments = { getState: () => getExperiments(), setBackgroundSubagents: getExperiments }
  platform.storage = sharedStorage.storage
  platform.observeStorage = sharedStorage.observeStorage
  host.installStorage()
  const stopPreferences = installDesktopPreferences(platform)
  const language = await platform.storage("opencode.global.dat").getItem("language")
  const locale = normalizeLocale((language && JSON.parse(language).locale) || navigator.language)
  if (locale !== "en") await loadLocaleDict(locale)
  const server: ServerConnection.Any = {
    type: "sidecar",
    variant: "base",
    http: { url: connection.url, username: connection.username, password: connection.password },
  }
  const defaultServer = (await platform.getDefaultServer?.()) ?? ServerConnection.key(server)
  root.textContent = ""
  render(() => {
    onCleanup(sharedStorage.dispose)
    onCleanup(services.dispose)
    onCleanup(stopPreferences)
    onCleanup(watchWindowState())
    onCleanup(watchTitlebarDragRegions())
    return (
      <PlatformProvider value={platform}>
        <AppBaseProviders locale={locale} onNativeTranslations={host.setNativeTranslations}>
          <AppInterface
            defaultServer={defaultServer}
            servers={[server]}
            router={(props: BaseRouterProps) => <DesktopMemoryRouter {...props} windowID={platform.windowID!} />}
          />
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
