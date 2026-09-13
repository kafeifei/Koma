type QuitEvent = { preventDefault(): void }

// Host adapters publish only confirmed shutdowns; new subscribers receive the
// current state so a terminal mounting during shutdown cannot start connecting.
export function createDesktopQuitState() {
  let quitting = false
  const listeners = new Set<(quitting: boolean) => void>()
  return {
    setQuitting: (value: boolean) => {
      if (quitting === value) return
      quitting = value
      listeners.forEach((listener) => listener(value))
    },
    subscribe: (listener: (quitting: boolean) => void) => {
      listeners.add(listener)
      listener(quitting)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

type ShutdownControllerOptions = {
  confirm?(): Promise<boolean>
  stop(): Promise<void>
  quit(): void
  setQuitting(value: boolean): void
  log(message: string, meta?: Record<string, unknown>): void
  warn(message: string, error?: unknown): void
  timeoutMs?: number
  schedule?: (callback: () => void) => void
}

export function createShutdownController(options: ShutdownControllerOptions) {
  let quitting = false
  let allowed = false
  let stopped = false
  let pending: Promise<boolean> | undefined
  let forced = false

  const markQuitting = () => {
    quitting = true
    options.setQuitting(true)
  }

  const finishQuit = (quit: () => void, reason: "stopped" | "failed" | "timed_out") => {
    allowed = true
    const schedule = options.schedule ?? ((callback) => setTimeout(callback, 0))
    // Native macOS quit enters Electron from AppKit. A Promise continuation can
    // reenter app.quit() before that callback returns, after which Electron's
    // outer frame overwrites its quitting state and leaves a windowless process.
    return new Promise<void>((resolve, reject) => {
      schedule(() => {
        options.log("runtime quit requested", { reason })
        try {
          quit()
          resolve()
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  const stop = (quit: () => void) =>
    new Promise<void>((resolve, reject) => {
      markQuitting()
      options.log("runtime shutdown started")

      let timedOut = false
      const timeout = setTimeout(() => {
        timedOut = true
        options.warn("runtime shutdown timed out; preserving its resource snapshot")
        void finishQuit(quit, "timed_out").then(resolve, reject)
      }, options.timeoutMs ?? 7_000)

      void options
        .stop()
        .then(() => {
          if (timedOut) return
          stopped = true
          options.log("runtime shutdown finished")
        })
        .catch((error) => {
          if (timedOut) return
          options.warn("failed to stop runtime; preserving its resource snapshot", error)
        })
        .finally(() => {
          if (timedOut) return
          clearTimeout(timeout)
          void finishQuit(quit, stopped ? "stopped" : "failed").then(resolve, reject)
        })
    })

  const failedQuit = (error: unknown) => {
    allowed = false
    quitting = false
    forced = false
    pending = undefined
    options.setQuitting(false)
    options.warn("failed to complete runtime quit; keeping the app open", error)
  }

  // The first quit/relaunch/install request owns the entire confirmation and
  // shutdown. Later requests cannot open a second dialog or replace its action.
  const requestQuit = (quit = options.quit): Promise<boolean> => {
    if (pending) return pending
    pending = (async () => {
      const confirmed = options.confirm
        ? await options.confirm().catch((error) => {
            options.warn("failed to confirm runtime shutdown; keeping the app open", error)
            return false
          })
        : true
      if (forced) return true
      if (!confirmed) return false
      await stop(quit)
      return true
    })()
      .catch((error) => {
        failedQuit(error)
        throw error
      })
      .finally(() => {
        if (!quitting) pending = undefined
      })
    return pending
  }

  // OS termination must not wait for an interactive confirmation. A pending
  // dialog may finish later, but it cannot start a second shutdown.
  const forceQuit = () => {
    if (quitting) return
    forced = true
    void stop(options.quit).catch(failedQuit)
  }

  const beforeQuit = (event: QuitEvent) => {
    if (allowed) {
      options.log("runtime quit admitted", { stopped })
      return
    }
    event.preventDefault()
    void requestQuit().catch(() => undefined)
  }

  const willQuit = () => {
    markQuitting()
    options.log("app will quit", { stopped })
    void options.stop()
  }

  return {
    beforeQuit,
    willQuit,
    requestQuit,
    forceQuit,
    isQuitting: () => quitting,
    didStop: () => stopped,
  }
}
