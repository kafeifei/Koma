import { expect, test } from "bun:test"
import { fork } from "node:child_process"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHostRPC } from "@opencode-ai/remote/desktop/ipc"

const binary = join(import.meta.dir, "../src-tauri/binaries/node")
test.skipIf(!(await Bun.file(binary).exists()))(
  "packaged Node host preserves HTTP, SSE and WebSockets from the Koma Bun backend",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "koma-native-host-"))
    await writeFile(join(directory, "web.html"), "shared-web-ui")
    const backend = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        if (request.headers.get("authorization") !== `Basic ${btoa("opencode:test")}`)
          return new Response("unauthorized", { status: 401 })
        if (new URL(request.url).pathname === "/pty") {
          if (server.upgrade(request)) return
          return new Response("upgrade required", { status: 400 })
        }
        if (new URL(request.url).pathname === "/event")
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("data: ready\n\n"))
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        return Response.json({ ready: true })
      },
      websocket: {
        message(socket, data) {
          socket.send(data)
        },
      },
    })
    const child = fork(join(import.meta.dir, "../src-tauri/binaries/host.cjs"), [], {
      execPath: binary,
      serialization: "json",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    })
    const exited = new Promise((resolve) => child.once("exit", resolve))
    const rpc = createHostRPC(
      {
        send: (message) => {
          child.send(message as any)
        },
        onMessage: (fn) => {
          child.on("message", fn)
        },
        onClose: (fn) => {
          child.once("exit", fn)
        },
      },
      async (method) => {
        if (method === "credentials.read") return null
        throw new Error("The test must not write credentials")
      },
    )
    let socket: WebSocket | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    try {
      await rpc("initialize", {
        directory,
        renderer: directory,
        backend: { url: backend.url.href, username: "opencode", password: "test" },
      })
      const state = await rpc("request", { service: "web", op: "setEnabled", enabled: true })
      expect(state.error).toBe(false)
      expect(await fetch(state.url).then((response) => response.text())).toBe("shared-web-ui")
      expect(await fetch(`${state.url}/global/health`).then((response) => response.json())).toEqual({ ready: true })
      expect((await fetch(state.url, { headers: { origin: "https://untrusted.example" } })).status).toBe(403)
      const stream = await fetch(`${state.url}/event`)
      reader = stream.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: ready\n\n")
      socket = new WebSocket(`${state.url.replace("http:", "ws:")}/pty`)
      const echo = new Promise((resolve, reject) => {
        socket!.onopen = () => socket!.send("terminal-roundtrip")
        socket!.onmessage = ({ data }) => resolve(data)
        socket!.onerror = reject
      })
      expect(await echo).toBe("terminal-roundtrip")
      await rpc("stop")
      await expect(fetch(state.url)).rejects.toThrow()
      expect((await fetch(backend.url, { headers: { authorization: `Basic ${btoa("opencode:test")}` } })).status).toBe(
        200,
      )
      const remote = await rpc("request", { service: "remote", op: "getState" })
      expect(remote.account).toBeNull()
    } finally {
      socket?.close()
      await reader?.cancel().catch(() => {})
      child.disconnect()
      await exited
      await backend.stop(true)
      await rm(directory, { recursive: true, force: true })
    }
  },
  15_000,
)
