import { afterEach, expect, test } from "bun:test"
import { ConnectionStatus } from "@microsoft/dev-tunnels-connections"
import type { Tunnel } from "@microsoft/dev-tunnels-contracts"
import type { TunnelManagementHttpClient } from "@microsoft/dev-tunnels-management"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { IncomingMessage, Server } from "node:http"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import type { RemoteClientFactory, RemoteRelayClient } from "./remote-client"
import { createRemoteDeviceConnector, RemoteClientError } from "./remote-client"

const cleanup = new Set<() => Promise<unknown>>()

afterEach(async () => {
  await Promise.allSettled(
    Array.from(cleanup)
      .reverse()
      .map((dispose) => dispose()),
  )
  cleanup.clear()
})

test("uses only the confirmed forwarded port or fails closed before transport fallback", async () => {
  const root = await webRoot()
  const requests: IncomingMessage["headers"][] = []
  const backend = createServer((incoming, response) => {
    requests.push(incoming.headers)
    response.end("remote backend")
  })
  const backendURL = new URL(await listen(backend))
  let fallbackRequests = 0
  const fallback = createServer((_incoming, response) => {
    fallbackRequests += 1
    response.end("public fallback")
  })
  const fallbackURL = new URL(await listen(fallback))
  const fallbackHost = `localhost:${fallbackURL.port}`
  const forwarded = { portNumber: 44, cancel: false }
  const expected = { portNumber: 8123, cancel: false }
  const calls: string[] = []
  const disconnected = Promise.withResolvers<void>()
  let forwarding: ((event: { readonly portNumber: number; cancel: boolean }) => void) | undefined
  let statusChanged: ((event: { readonly status: ConnectionStatus }) => void) | undefined
  const relay: RemoteRelayClient = {
    connectionStatus: ConnectionStatus.Connected,
    acceptLocalConnectionsForForwardedPorts: true,
    portForwarding(listener) {
      forwarding = listener
      return { dispose: () => calls.push("unsubscribe") }
    },
    connectionStatusChanged(listener) {
      statusChanged = listener
      return { dispose: () => calls.push("unsubscribe") }
    },
    async connect() {
      calls.push("connect")
      forwarding?.(forwarded)
      forwarding?.(expected)
    },
    async waitForForwardedPort(port) {
      calls.push(`wait:${port}`)
    },
    async connectToForwardedPort(port) {
      calls.push(`stream:${port}`)
      return createConnection(Number(backendURL.port), backendURL.hostname)
    },
    async dispose() {
      calls.push("dispose")
    },
  }
  const connect = createRemoteDeviceConnector(
    remoteFactory(relay, {
      id: "use1/device123",
      name: "Studio Mac",
      online: true,
      url: `https://${fallbackHost}`,
      port: expected.portNumber,
      clusterId: "use1",
      tunnelId: "device123",
    }),
  )
  const connection = await connect({
    management: {} as TunnelManagementHttpClient,
    id: "use1/device123",
    root,
    clientOrigin: "oc://renderer",
    onDisconnected: () => disconnected.resolve(),
  })
  cleanup.add(() => connection.stop())

  expect(connection.name).toBe("Studio Mac")
  expect(new URL(connection.url).hostname).toBe("127.0.0.1")
  expect(relay.acceptLocalConnectionsForForwardedPorts).toBe(false)
  expect(forwarded.cancel).toBe(true)
  expect(expected.cancel).toBe(false)
  expect(calls).toEqual(["connect", `wait:${expected.portNumber}`])

  const response = await fetch(`${connection.url}/api/session`, {
    headers: {
      origin: "oc://renderer",
      "sec-fetch-site": "cross-site",
      "x-tunnel-authorization": "must-not-forward",
    },
  })
  const responseBody = await response.text()
  if (process.versions.bun === "1.3.14") {
    expect(response.status).toBe(502)
    expect(responseBody).toBe("Bad Gateway")
    expect(requests).toHaveLength(0)
    expect(calls).not.toContain(`stream:${expected.portNumber}`)
  }
  if (process.versions.bun !== "1.3.14") {
    expect(responseBody).toBe("remote backend")
    expect(response.headers.get("access-control-allow-origin")).toBe("oc://renderer")
    expect(requests[0]?.host).toBe(fallbackHost)
    expect(requests[0]?.origin).toBe(`https://${fallbackHost}`)
    expect(requests[0]?.["x-tunnel-authorization"]).toBeUndefined()
    expect(calls).toContain(`stream:${expected.portNumber}`)
  }
  expect(fallbackRequests).toBe(0)

  statusChanged?.({ status: ConnectionStatus.Disconnected })
  await disconnected.promise
  await connection.stop()

  const reopened = await connect({
    management: {} as TunnelManagementHttpClient,
    id: "use1/device123",
    root,
    clientOrigin: "oc://renderer",
  })
  cleanup.add(() => reopened.stop())
  expect(reopened.url).toBe(connection.url)
  await Promise.all([reopened.stop(), reopened.stop()])
  expect(calls.filter((value) => value === "unsubscribe")).toHaveLength(4)
  expect(calls.filter((value) => value === "dispose")).toHaveLength(2)
})

test("bounds relay startup and disposes a partial connection", async () => {
  const root = await webRoot()
  let disposed = 0
  const relay: RemoteRelayClient = {
    connectionStatus: ConnectionStatus.Connecting,
    acceptLocalConnectionsForForwardedPorts: true,
    portForwarding: () => ({ dispose: () => undefined }),
    connectionStatusChanged: () => ({ dispose: () => undefined }),
    connect: () => new Promise(() => undefined),
    waitForForwardedPort: async () => undefined,
    connectToForwardedPort: async () => new PassThrough(),
    dispose: async () => {
      disposed += 1
    },
  }
  const connect = createRemoteDeviceConnector({
    ...remoteFactory(relay),
    timeoutMs: 20,
  })

  await expect(
    connect({
      management: {} as TunnelManagementHttpClient,
      id: "use1/device123",
      root,
      clientOrigin: "oc://renderer",
    }),
  ).rejects.toEqual(new RemoteClientError("timed_out"))
  expect(disposed).toBe(1)
})

test("cancels before management completes and rejects an unconfirmed endpoint", async () => {
  const root = await webRoot()
  const controller = new AbortController()
  controller.abort()
  const pending = createRemoteDeviceConnector({
    timeoutMs: 1_000,
    getTunnel: () => new Promise(() => undefined),
    createRelay: () => {
      throw new Error("relay must not be created")
    },
  })
  await expect(
    pending({
      management: {} as TunnelManagementHttpClient,
      id: "use1/device123",
      root,
      clientOrigin: "oc://renderer",
      signal: controller.signal,
    }),
  ).rejects.toEqual(new RemoteClientError("cancelled"))

  const invalid = createRemoteDeviceConnector(
    remoteFactory(undefined, {
      id: "use1/device123",
      name: "Studio Mac",
      online: null,
      url: null,
      port: 8123,
      clusterId: "use1",
      tunnelId: "device123",
    }),
  )
  await expect(
    invalid({
      management: {} as TunnelManagementHttpClient,
      id: "use1/device123",
      root,
      clientOrigin: "oc://renderer",
    }),
  ).rejects.toEqual(new RemoteClientError("invalid_device"))
})

function remoteFactory(
  relay?: RemoteRelayClient,
  device: Awaited<ReturnType<RemoteClientFactory["getTunnel"]>>["device"] = {
    id: "use1/device123",
    name: "Studio Mac",
    online: true,
    url: "https://device-4321.example.devtunnels.ms",
    port: 8123,
    clusterId: "use1",
    tunnelId: "device123",
  },
): RemoteClientFactory {
  return {
    timeoutMs: 1_000,
    getTunnel: async () => ({ device, tunnel: {} as Tunnel }),
    createRelay: () => {
      if (!relay) throw new Error("relay must not be created")
      return relay
    },
  }
}

async function webRoot() {
  const root = await mkdtemp(join(tmpdir(), "opencode-remote-client-"))
  await mkdir(join(root, "assets"))
  await writeFile(join(root, "web.html"), "web-shell")
  cleanup.add(() => rm(root, { recursive: true, force: true }))
  return root
}

function listen(server: Server) {
  return new Promise<string>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("Expected TCP server"))
      cleanup.add(() => close(server))
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function close(server: Server) {
  server.closeAllConnections()
  return new Promise<void>((resolve, reject) => {
    if (!server.listening) return resolve()
    server.close((error) => (error ? reject(error) : resolve()))
  })
}
