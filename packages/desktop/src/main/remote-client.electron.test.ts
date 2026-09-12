import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const fixtures: string[] = []
const children: { kill(): void; exited: Promise<number> }[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill()
    await child.exited
  }
  fixtures.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
})

test.skipIf(process.env.OPENCODE_ELECTRON_TEST !== "1")(
  "uses only relay streams in the packaged Electron Node runtime",
  async () => {
    const base = mkdtempSync(join(import.meta.dir, ".remote-client-electron-"))
    fixtures.push(base)
    const source = join(base, "fixture.ts")
    writeFileSync(
      source,
      `
      import assert from "node:assert/strict"
      import { mkdir, writeFile } from "node:fs/promises"
      import { createServer } from "node:http"
      import { createConnection } from "node:net"
      import { join } from "node:path"
      import { ConnectionStatus } from "@microsoft/dev-tunnels-connections"
      import { createRemoteDeviceConnector } from ${JSON.stringify(resolve(import.meta.dir, "remote-client.ts"))}

      const sockets = new Set()
      const requests = []
      let fallbackRequests = 0
      let privateConnections = 0
      let rejectedConnections = 0
      const root = ${JSON.stringify(join(base, "web"))}
      await mkdir(join(root, "assets"), { recursive: true })
      await writeFile(join(root, "web.html"), "shell")
      const backend = createServer((request, response) => {
        requests.push(request.url)
        if (request.url === "/event") {
          response.writeHead(200, { "content-type": "text/event-stream" })
          response.write("data: node24\\n\\n")
          return
        }
        response.end("private")
      })
      backend.on("connection", (socket) => {
        sockets.add(socket)
        socket.once("close", () => sockets.delete(socket))
      })
      backend.on("upgrade", (request, socket) => {
        requests.push(request.url)
        socket.write("HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n")
      })
      const fallback = createServer((_request, response) => {
        fallbackRequests += 1
        response.end("public fallback")
      })
      const backendPort = await listen(backend)
      const fallbackPort = await listen(fallback)
      const device = {
        id: "use1/device123",
        name: "Node 24 Mac",
        online: true,
        url: "https://localhost:" + fallbackPort,
        port: 8123,
        clusterId: "use1",
        tunnelId: "device123",
      }
      const relay = (connect) => ({
        connectionStatus: ConnectionStatus.Connected,
        acceptLocalConnectionsForForwardedPorts: true,
        portForwarding: () => ({ dispose() {} }),
        connectionStatusChanged: () => ({ dispose() {} }),
        async connect() {},
        async waitForForwardedPort() {},
        connectToForwardedPort: connect,
        async dispose() {},
      })
      const connector = (connect) => createRemoteDeviceConnector({
        timeoutMs: 1_000,
        async getTunnel() { return { device, tunnel: {} } },
        createRelay() { return relay(connect) },
      })
      const connection = await connector(async () => {
        privateConnections += 1
        return createConnection(backendPort, "127.0.0.1")
      })({ management: {}, id: device.id, root, clientOrigin: "oc://renderer" })
      const headers = { origin: "oc://renderer", "sec-fetch-site": "cross-site" }
      const response = await fetch(connection.url + "/api", { headers })
      assert.equal(await response.text(), "private")
      assert.equal(response.headers.get("access-control-allow-origin"), "oc://renderer")
      const event = await fetch(connection.url + "/event", { headers })
      const reader = event.body.getReader()
      assert.equal(new TextDecoder().decode((await reader.read()).value), "data: node24\\n\\n")
      await reader.cancel()
      assert.match(await upgrade(connection.url), /101 Switching Protocols/)
      await connection.stop()

      const unavailable = await connector(async () => {
        rejectedConnections += 1
        throw new Error("relay unavailable")
      })({ management: {}, id: device.id, root, clientOrigin: "oc://renderer" })
      assert.equal(await fetch(unavailable.url + "/api", { headers }).then((value) => value.status), 502)
      await unavailable.stop()
      assert.deepEqual(requests, ["/api", "/event", "/ws"])
      assert.equal(privateConnections, 3)
      assert.equal(rejectedConnections, 1)
      assert.equal(fallbackRequests, 0)
      sockets.forEach((socket) => socket.destroy())
      await close(backend)
      await close(fallback)
      console.log(JSON.stringify({ node: process.versions.node, fallbackRequests }))

      function listen(server) {
        return new Promise((resolve, reject) => {
          server.once("error", reject)
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject)
            resolve(server.address().port)
          })
        })
      }

      function close(server) {
        server.closeAllConnections()
        return new Promise((resolve, reject) => {
          if (!server.listening) return resolve()
          server.close((error) => error ? reject(error) : resolve())
        })
      }

      function upgrade(url) {
        const target = new URL(url)
        return new Promise((resolve, reject) => {
          const socket = createConnection(Number(target.port), target.hostname)
          let data = ""
          socket.on("connect", () => socket.write(
            "GET /ws HTTP/1.1\\r\\nHost: " + target.host +
            "\\r\\nOrigin: oc://renderer\\r\\nSec-Fetch-Site: cross-site" +
            "\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n",
          ))
          socket.on("data", (chunk) => {
            data += chunk
            if (!data.includes("\\r\\n\\r\\n")) return
            socket.destroy()
            resolve(data)
          })
          socket.on("error", reject)
        })
      }
    `,
    )
    const build = await Bun.build({
      entrypoints: [source],
      outdir: base,
      target: "node",
      external: [
        "@microsoft/dev-tunnels-connections",
        "@microsoft/dev-tunnels-contracts",
        "@microsoft/dev-tunnels-management",
      ],
    })
    expect(build.success).toBe(true)
    const executable =
      process.env.OPENCODE_NODE_TEST_BINARY ??
      resolve(
        import.meta.dir,
        "../../node_modules/electron/dist",
        process.platform === "darwin"
          ? "Electron.app/Contents/MacOS/Electron"
          : process.platform === "win32"
            ? "electron.exe"
            : "electron",
      )
    expect(existsSync(executable)).toBe(true)
    const child = Bun.spawn([executable, join(base, "fixture.js")], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    children.push(child)
    const timeout = setTimeout(() => child.kill(), 10_000)
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    clearTimeout(timeout)
    if (exit !== 0) throw new Error(stderr)
    const result = JSON.parse(stdout)
    expect(Number(result.node.split(".")[0])).toBeGreaterThanOrEqual(22)
    expect(result.fallbackRequests).toBe(0)
  },
  15_000,
)
