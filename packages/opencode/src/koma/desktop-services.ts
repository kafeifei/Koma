import { fork } from "node:child_process"
import { dirname, join } from "node:path"
import { KomaBackend } from "@opencode-ai/core/koma-backend"
import { StoragePaths } from "@opencode-ai/core/storage-paths"
import { createHostRPC } from "@opencode-ai/remote/desktop/ipc"
import { createKomaCredentials } from "./credentials"

let current: ReturnType<typeof start> | undefined
async function start() {
  const root = process.env.KOMA_HOME
  const renderer = process.env.KOMA_DESKTOP_RENDERER
  if (!root || !renderer) throw new Error("This backend has no desktop host services")
  const backend = await KomaBackend.discover(root)
  if (!backend) throw new Error("Koma desktop backend is unavailable")
  const runtime = dirname(renderer)
  const child = fork(join(runtime, "host.cjs"), [], {
    execPath: join(runtime, "node"),
    // A compiled Bun CLI carries Bun-only flags such as --user-agent.
    execArgv: [],
    serialization: "json",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  })
  const credentials = createKomaCredentials(StoragePaths.resolve(root).root)
  const request = createHostRPC(
    {
      send: (message) => {
        child.send(message as any)
      },
      onMessage: (callback) => {
        child.on("message", callback)
      },
      onClose: (callback) => {
        child.once("exit", callback)
        child.once("error", callback)
      },
    },
    async (method, params) => {
      if (method === "credentials.read") return credentials.read()
      if (method === "credentials.write") return credentials.write(params)
      if (method === "credentials.clear") return credentials.clear()
      throw new Error("Unknown native credential operation")
    },
  )
  try {
    await request("initialize", { directory: join(KomaBackend.stateDirectory(root), "desktop"), renderer, backend })
  } catch (error) {
    child.kill()
    throw error
  }
  child.once("exit", () => {
    current = undefined
  })
  return {
    request: (payload: unknown) => request("request", payload),
    async stop() {
      try {
        await request("stop")
      } finally {
        if (child.connected) child.disconnect()
      }
    },
  }
}
export async function desktopServiceRequest(payload: unknown) {
  const host = await (current ??= start().catch((error) => {
    current = undefined
    throw error
  }))
  return host.request(payload)
}
export async function stopDesktopServices() {
  await (await current)?.stop()
}
