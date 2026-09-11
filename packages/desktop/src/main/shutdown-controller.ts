type QuitEvent = { preventDefault(): void }

type ShutdownControllerOptions = {
  stop(): Promise<void>
  quit(): void
  setQuitting(): void
  log(message: string, meta?: Record<string, unknown>): void
  warn(message: string, error?: unknown): void
  timeoutMs?: number
  schedule?: (callback: () => void) => void
}

export function createShutdownController(options: ShutdownControllerOptions) {
  let quitting = false
  let allowed = false
  let stopping = false
  let stopped = false
  let scheduled = false

  const markQuitting = () => {
    quitting = true
    options.setQuitting()
  }

  const requestQuit = (reason: "stopped" | "failed" | "timed_out") => {
    if (scheduled) return
    allowed = true
    scheduled = true
    const schedule = options.schedule ?? setImmediate
    // Native macOS quit enters Electron from AppKit. A Promise continuation can
    // reenter app.quit() before that callback returns, after which Electron's
    // outer frame overwrites its quitting state and leaves a windowless process.
    schedule(() => {
      options.log("runtime quit requested", { reason })
      options.quit()
    })
  }

  const beforeQuit = (event: QuitEvent) => {
    markQuitting()
    if (allowed) {
      options.log("runtime quit admitted", { stopped })
      return
    }

    event.preventDefault()
    if (stopping) return
    stopping = true
    options.log("runtime shutdown started")

    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      options.warn("runtime shutdown timed out; preserving its resource snapshot")
      requestQuit("timed_out")
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
        requestQuit(stopped ? "stopped" : "failed")
      })
  }

  const willQuit = () => {
    markQuitting()
    options.log("app will quit", { stopped })
    void options.stop()
  }

  return {
    beforeQuit,
    willQuit,
    markQuitting,
    isQuitting: () => quitting,
    didStop: () => stopped,
  }
}
