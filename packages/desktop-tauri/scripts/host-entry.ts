import { createDesktopHostServices } from "@opencode-ai/remote/desktop/services"
import { createHostRPC } from "@opencode-ai/remote/desktop/ipc"

let host: ReturnType<typeof createDesktopHostServices> | undefined
const request = createHostRPC(
  {
    send: (message) => process.send!(message as any),
    onMessage: (callback) => {
      process.on("message", callback)
    },
    onClose: (callback) => {
      process.once("disconnect", callback)
    },
  },
  async (method, params) => {
    if (method === "initialize") {
      host ??= createDesktopHostServices({
        ...params,
        backend: async () => params.backend,
        credentials: {
          available: () => true,
          read: () => request("credentials.read"),
          write: (value) => request("credentials.write", value),
          clear: () => request("credentials.clear"),
        },
      })
      return true
    }
    if (method === "stop") {
      await host?.stop()
      return true
    }
    if (method !== "request" || !host) throw new Error("Desktop host is not ready")
    return host.request(params)
  },
)
process.once("disconnect", () => {
  const deadline = setTimeout(() => process.exit(0), 7_000)
  void host?.stop().finally(() => {
    clearTimeout(deadline)
    process.exit(0)
  })
  if (!host) process.exit(0)
})
