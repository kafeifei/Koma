import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
import * as http from "node:http"
import { createServer } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { getCACertificates, setDefaultCACertificates } from "node:tls"
import type { Event } from "electron"
import { app, BrowserWindow, dialog } from "electron"
import { StoragePaths } from "@opencode-ai/core/storage-paths"

import { Deferred, Effect, Fiber } from "effect"
import contextMenu from "electron-context-menu"

import type { ServerReadyData } from "../preload/types"
import { checkAppExists, resolveAppPath } from "./apps"
import { APP_ID, APP_NAME, APP_PROTOCOL, CHANNEL } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand } from "./ipc"
import { forwardInitializationFailure } from "./initialization"
import { exportDebugLogs, initCrashReporter, initLogging, startNetLog, write as writeLog } from "./logging"
import { createMenu } from "./menu"
import {
  finishFirstLaunchOnboarding,
  initializeOldLayoutEligibility,
  isFirstLaunchOnboardingPending,
  isOldLayoutEligible,
} from "./onboarding"
import {
  getDefaultServerUrl,
  preferAppEnv,
  setDefaultServerUrl,
  spawnLocalServer,
  type SidecarListener,
} from "./server"
import { setupAutoUpdater, showUpdaterDialog } from "./updater"
import { safeWebContentsURL } from "./window-state"
import {
  getLastFocusedWindow,
  registerRendererProtocol,
  setRelaunchHandler,
  setAppQuitting,
  setBackgroundColor,
  setDockIcon,
  restoreMainWindows,
} from "./windows"
import { createWslServersController } from "./wsl/servers"
import { registerWslIpcHandlers } from "./wsl/ipc"
import { spawnWslSidecar } from "./wsl/sidecar"
import { migrate } from "./migrate"
import { cleanupStoreFiles } from "./store-cleanup"
import { startBackgroundCli } from "./background-cli"
import { nativeT, setNativeTranslations } from "./native-translations"
import { prepareLabDesktopHome, prepareLabEnvironment } from "./lab-environment"
import { createRemoteAccess } from "./remote-access"
import { createWebEntryController } from "./web-entry-controller"
import { initializeRuntimeResources, runtimePath } from "./resources"
import { ensureLabBackend } from "./lab-backend"
import { createShutdownController } from "./shutdown-controller"
import { createBackendExperiments } from "./backend-experiments"
import { confirmBackendShutdown } from "./shutdown-confirmation"

const TEST_ONBOARDING = process.env.OPENCODE_TEST_ONBOARDING === "1"
const SIDECAR_VERSION = process.env.OPENCODE_SIDECAR_V2 === "1" ? "v2" : "v1"
const jsCallStackFeature = "DocumentPolicyIncludeJSCallStacksInCrashReports"

let logger: ReturnType<typeof initLogging>
let server: SidecarListener | null = null

const pendingDeepLinks: string[] = []

function useEnvProxy() {
  try {
    // Electron 41.2 runs Node 24.14.1; latest @types/node@24 is 24.12.2.
    ;(http as any).setGlobalProxyFromEnv()
  } catch (error) {
    logger.warn("failed to load proxy environment", error)
  }
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  const normalized = urls.map((url) =>
    APP_PROTOCOL === "opencode" ? url : url.replace(`${APP_PROTOCOL}://`, "opencode://"),
  )
  pendingDeepLinks.push(...normalized)
  const win = getLastFocusedWindow()
  if (win) sendDeepLinks(win, normalized)
}

async function killSidecar() {
  if (!server) return
  const current = server
  server = null
  await current.stop()
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

const main = Effect.gen(function* () {
  contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

  // on macOS apps run in `/` which can cause issues with ripgrep
  try {
    process.chdir(homedir())
  } catch {}

  process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

  const appId = app.isPackaged || CHANNEL === "lab" ? APP_ID : "ai.opencode.desktop.dev"
  const onboardingTestRoot = ((): string | undefined => {
    if (!TEST_ONBOARDING) return

    const root = join(tmpdir(), `opencode-onboarding-${randomUUID()}`)
    rmSync(root, { recursive: true, force: true })
    ;["data", "config", "cache", "state", "desktop", "session"].forEach((dir) =>
      mkdirSync(join(root, dir), { recursive: true }),
    )
    process.env.OPENCODE_DB = ":memory:"
    delete process.env.OPENCODE_HOME
    process.env.XDG_DATA_HOME = join(root, "data")
    process.env.XDG_CONFIG_HOME = join(root, "config")
    process.env.XDG_CACHE_HOME = join(root, "cache")
    process.env.XDG_STATE_HOME = join(root, "state")
    return root
  })()
  app.setName(app.isPackaged || CHANNEL === "lab" ? APP_NAME : "OpenCode Dev")
  app.setAppUserModelId(appId)
  const labRoot =
    CHANNEL === "lab" && !onboardingTestRoot ? (process.env.OPENCODE_HOME ?? join(homedir(), ".opencode")) : undefined
  if (labRoot) {
    const prepared = yield* Effect.promise(async () => {
      try {
        const root = StoragePaths.resolve(labRoot).root
        const paths = {
          root,
          legacyRoot:
            root === join(homedir(), ".opencode") ? join(app.getPath("appData"), "OpenCode Lab") : `${root}.legacy`,
        }
        if (
          !(await prepareLabDesktopHome({
            ...paths,
            setUserData: (path) => app.setPath("userData", path),
            acquireLock: () => app.requestSingleInstanceLock(),
          }))
        )
          return false
        prepareLabEnvironment(process.env, root)
        return true
      } catch (error) {
        dialog.showErrorBox(
          nativeT("desktop.recovery.loadFailed"),
          error instanceof Error ? error.message : String(error),
        )
        return false
      }
    })
    if (!prepared) {
      app.quit()
      return
    }
  }
  const userDataPath = onboardingTestRoot
    ? join(onboardingTestRoot, "desktop")
    : labRoot
      ? StoragePaths.resolve(labRoot).desktop
      : join(app.getPath("appData"), appId)
  app.setPath("userData", userDataPath)
  if (onboardingTestRoot) app.setPath("sessionData", join(onboardingTestRoot, "session"))
  if (CHANNEL === "lab" && !onboardingTestRoot) app.setPath("sessionData", join(userDataPath, "session"))
  initializeOldLayoutEligibility(app.getPath("userData"))
  logger = initLogging()
  initCrashReporter()

  const serverReady = Deferred.makeUnsafe<ServerReadyData, unknown>()
  let webEntry: ReturnType<typeof createWebEntryController> | undefined
  let remoteAccess: ReturnType<typeof createRemoteAccess> | undefined

  const wslServers = createWslServersController(
    app.getVersion(),
    async (distro) => {
      logger.log("spawning wsl sidecar", { distro })
      return spawnWslSidecar(distro, {
        onLine: (line) => logger.log("wsl sidecar", { distro, stream: line.stream, text: line.text }),
      })
    },
    {
      logger: {
        log: (message, meta) => logger.log(message, meta),
        error: (message, meta) => logger.error(message, meta),
      },
    },
  )
  let startingLabBackend: ReturnType<typeof ensureLabBackend> | undefined
  let stopping: Promise<void> | undefined
  const stopSidecars = () => {
    return (stopping ??= (async () => {
      wslServers.stopAll()
      if (startingLabBackend) await startingLabBackend.then((backend) => backend.listener.stop())
      await Promise.all([webEntry?.stop(), remoteAccess?.stop(), killSidecar()])
    })())
  }
  try {
    setDefaultCACertificates([...new Set([...getCACertificates("default"), ...getCACertificates("system")])])
  } catch (error) {
    logger.warn("failed to load system certificates", error)
  }

  logger.log("app starting", {
    version: app.getVersion(),
    build: import.meta.env.OPENCODE_BUILD,
    packaged: app.isPackaged,
    onboardingTest: Boolean(onboardingTestRoot),
  })

  ensureLoopbackNoProxy()
  useEnvProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")
  const features = app.commandLine.getSwitchValue("enable-features")
  app.commandLine.appendSwitch("enable-features", features ? `${jsCallStackFeature},${features}` : jsCallStackFeature)
  if (!app.isPackaged) app.commandLine.appendSwitch("remote-debugging-port", "9222")

  if (!labRoot && !app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  const resources = initializeRuntimeResources()
  logger.log("runtime resources prepared", { renderer: runtimePath("renderer") })
  let initialized = false
  const shutdown = createShutdownController({
    confirm: () =>
      confirmBackendShutdown({
        backend: async () => (startingLabBackend ? (await startingLabBackend).connection : undefined),
        showDialog: (options) => dialog.showMessageBox(options),
        warn: (error) => logger.warn("failed to check Lab tasks before quitting", error),
      }),
    stop: stopSidecars,
    quit: () => app.quit(),
    setQuitting: setAppQuitting,
    log: (message, meta) => logger.log(message, meta),
    warn: (message, error) => logger.warn(message, error),
  })
  const relaunch = () => {
    void shutdown
      .requestQuit(() => {
        app.relaunch()
        app.quit()
      })
      .catch(() => undefined)
  }
  // Cleanup is scoped to this process and happens after windows and sidecars stop.
  // A crash may leave its temp snapshot; another instance must not remove it.
  app.once("quit", () => {
    const stopped = shutdown.didStop()
    logger.log("app quit", { stopped, initialized })
    if (!stopped || !initialized) return
    try {
      resources.dispose()
    } catch (error) {
      logger.warn("failed to remove runtime resource snapshot", error)
    }
  })

  const shellEnv = preferAppEnv(app.getPath("userData"))
  if (labRoot) prepareLabEnvironment(process.env, labRoot)

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith(`${APP_PROTOCOL}://`))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    const win = getLastFocusedWindow()
    if (win) {
      win.show()
      win.focus()
    }
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", shutdown.beforeQuit)
  app.on("will-quit", shutdown.willQuit)

  app.on("child-process-gone", (_event, details) => {
    writeLog("utility", "child process gone", { details }, "error")
  })

  app.on("render-process-gone", (_event, webContents, details) => {
    writeLog("window", "app render process gone", { url: safeWebContentsURL(webContents), details }, "error")
  })

  setRelaunchHandler(() => {
    relaunch()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      shutdown.forceQuit()
    })
  }

  yield* Effect.promise(() => app.whenReady())

  if (!TEST_ONBOARDING && (!labRoot || StoragePaths.resolve(labRoot).root === join(homedir(), ".opencode"))) migrate()
  yield* Effect.promise(() => cleanupStoreFiles(app.getPath("userData"))).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        if (result.deleted.length === 0) return
        logger.log("cleaned scoped store files", { count: result.deleted.length, scanned: result.scanned })
      }),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to clean scoped store files", error)
      }),
    ),
  )
  webEntry = createWebEntryController({
    backend: () => Effect.runPromise(Deferred.await(serverReady)),
    root: runtimePath("renderer"),
    changed: (state) => {
      BrowserWindow.getAllWindows().forEach((win) => win.webContents.send("web-entry-state", state))
      logger.log("web entry changed", state)
    },
    failed: (error) => logger.error("web entry failed", error),
  })
  remoteAccess = createRemoteAccess({
    backend: () => Effect.runPromise(Deferred.await(serverReady)),
    root: runtimePath("renderer"),
    clientOrigin: process.env.ELECTRON_RENDERER_URL
      ? new URL(process.env.ELECTRON_RENDERER_URL).origin
      : "oc://renderer",
    changed: (state) => {
      BrowserWindow.getAllWindows().forEach((win) => win.webContents.send("remote-access-state", state))
    },
    failed: (failure) => logger.error("remote access failed", failure),
  })
  app.setAsDefaultProtocolClient(APP_PROTOCOL)
  registerRendererProtocol()
  setDockIcon()
  const updater = setupAutoUpdater(shutdown.requestQuit)
  const menuDeps = {
    trigger: (id: string) => {
      const win = getLastFocusedWindow()
      if (win) sendMenuCommand(win, id)
    },
    checkForUpdates: () => void showUpdaterDialog(updater, true),
    relaunch,
  }
  registerIpcHandlers({
    backendExperiments: labRoot
      ? createBackendExperiments({ root: labRoot, backend: () => Effect.runPromise(Deferred.await(serverReady)) })
      : undefined,
    webEntry,
    remoteAccess,
    killSidecar: () => killSidecar(),
    relaunch,
    awaitInitialization: Effect.fnUntraced(
      function* () {
        logger.log("awaiting server ready")
        const res = yield* Deferred.await(serverReady)
        logger.log("server ready", { url: res.url })
        return res
      },
      (e) => Effect.runPromise(e),
    ),
    consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
    getDefaultServerUrl: () => getDefaultServerUrl(),
    setDefaultServerUrl: (url) => setDefaultServerUrl(url),
    isFirstLaunchOnboardingPending,
    finishFirstLaunchOnboarding,
    isOldLayoutEligible,
    getDisplayBackend: async () => null,
    setDisplayBackend: async () => undefined,
    checkAppExists: (appName) => checkAppExists(appName),
    resolveAppPath: async (appName) => resolveAppPath(appName),
    updater,
    showUpdater: () => showUpdaterDialog(updater, true),
    setBackgroundColor: (color) => setBackgroundColor(color),
    exportDebugLogs: () => exportDebugLogs(),
    recordFatalRendererError: (error) => writeLog("renderer", "fatal renderer error", { ...error }, "error"),
    setNativeTranslations: (bundle) => {
      if (setNativeTranslations(bundle)) createMenu(menuDeps)
    },
  })
  registerWslIpcHandlers(wslServers)
  void updater.start()
  const updateTimer = setInterval(() => void updater.check(), 10 * 60 * 1000)
  updateTimer.unref()
  app.once("will-quit", () => clearInterval(updateTimer))
  yield* Effect.promise(() => startNetLog()).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        logger.warn("failed to start net log", error)
      }),
    ),
  )

  const loadingTask = yield* Effect.gen(function* () {
    logger.log("sidecar connection started", { version: SIDECAR_VERSION })

    ensureLoopbackNoProxy()
    useEnvProxy()

    if (CHANNEL === "lab" && labRoot) {
      logger.log("connecting shared Lab backend")
      const sidecar = yield* Effect.promise(
        () =>
          (startingLabBackend = ensureLabBackend({
            root: labRoot,
            source: join(
              app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources"),
              process.platform === "win32" ? "opencode-lab.exe" : "opencode-lab",
            ),
            logger,
          })),
      )
      server = sidecar.listener
      yield* Deferred.succeed(serverReady, {
        url: sidecar.connection.url,
        username: sidecar.connection.username,
        password: sidecar.connection.password,
      })

      if (process.platform === "win32") {
        void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
      }

      logger.log("loading task finished")
      return
    }

    if (SIDECAR_VERSION === "v2") {
      logger.log("spawning v2 sidecar")
      const sidecar = yield* Effect.promise(() =>
        startBackgroundCli(logger, shellEnv?.XDG_STATE_HOME, { isolated: CHANNEL === "lab" }),
      )
      yield* Deferred.succeed(serverReady, {
        url: sidecar.url,
        username: sidecar.username,
        password: sidecar.password,
      })

      if (process.platform === "win32") {
        void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
      }

      logger.log("loading task finished")
      return
    }

    const port = yield* Effect.gen(function* () {
      const fromEnv = process.env.OPENCODE_PORT
      if (fromEnv) {
        const parsed = Number.parseInt(fromEnv, 10)
        if (!Number.isNaN(parsed)) return parsed
      }

      const res = yield* Deferred.make<number, unknown>()
      const socket = createServer()
      socket.on("error", (e) => Deferred.failSync(res, () => e))
      socket.listen(0, "127.0.0.1", () => {
        const address = socket.address()
        if (typeof address !== "object" || !address) {
          socket.close()
          Deferred.failSync(res, () => new Error("Failed to get port"))
          return
        }
        const port = address.port
        socket.close(() => Effect.runSync(Deferred.succeed(res, port)))
      })

      return yield* Deferred.await(res)
    })
    const hostname = "127.0.0.1"
    const url = `http://${hostname}:${port}`
    const password = randomUUID()

    logger.log("spawning sidecar", { url })
    const { listener, health } = yield* Effect.promise(() =>
      spawnLocalServer(hostname, port, password, {
        userDataPath: app.getPath("userData"),
        onStdout: (message) => writeLog("server", "stdout", { message }),
        onStderr: (message) => writeLog("server", "stderr", { message }, "warn"),
        onExit: (code) => writeLog("utility", "sidecar exited", { code }, "warn"),
      }),
    )
    server = listener
    yield* Deferred.succeed(serverReady, {
      url,
      username: "opencode",
      password,
    })

    if (process.platform === "win32") {
      void wslServers.initialize().catch((error) => logger.error("wsl server initialization failed", error))
    }

    yield* Effect.promise(() => health.wait).pipe(
      Effect.timeout("30 seconds"),
      Effect.catch((e) =>
        Effect.sync(() => {
          logger.error("sidecar health check failed", e.toString())
        }),
      ),
    )

    logger.log("loading task finished")
  }).pipe(forwardInitializationFailure(serverReady), Effect.forkChild)

  yield* Fiber.await(loadingTask)
  if (stopping) return
  yield* Effect.promise(() => webEntry.initialize())
  void remoteAccess.initialize()
  if (stopping) return

  app.on("window-all-closed", () => {
    if (process.platform === "darwin") return
    app.quit()
  })
  app.on("activate", () => {
    if (shutdown.isQuitting()) {
      logger.log("app activation ignored during shutdown")
      return
    }
    if (BrowserWindow.getAllWindows().length > 0) return
    restoreMainWindows()
  })

  const windows = restoreMainWindows()
  if (windows.length) createMenu(menuDeps)
  initialized = true
})

Effect.runFork(main)
