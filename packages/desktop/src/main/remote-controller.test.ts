import { describe, expect, test } from "bun:test"
import { createRemoteController } from "./remote-controller"
import { createRemoteCredentials } from "./remote-credentials"

function fixture(overrides: Partial<Parameters<typeof createRemoteController>[0]> = {}) {
  const settings = new Map<string, unknown>()
  const events: string[] = []
  const device = {
    id: "use1/hello-world",
    name: "Computer",
    online: true,
    url: "https://hello.use1.devtunnels.ms/",
    port: 1234,
    clusterId: "use1",
    tunnelId: "hello-world",
  }
  const controller = createRemoteController({
    credentials: {
      available: () => true,
      read: () => undefined,
      write: () => {
        events.push("save-credential")
      },
      clear: () => {
        events.push("clear-credential")
      },
    },
    settings: {
      get: (key) => settings.get(key),
      set: (key, value) => {
        settings.set(key, value)
      },
    },
    deviceID: "test-device",
    deviceName: "Computer",
    website: null,
    changed: () => {},
    login: async () => ({
      deviceCode: "private-device-code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      expiresAt: Date.now() + 60_000,
      interval: 1,
    }),
    waitLogin: async () => ({ accessToken: "private-token" }),
    account: async () => ({ id: 10, name: "Tester", username: "tester" }),
    refreshCredential: async () => ({ accessToken: "new-private-token" }),
    list: async () => [device, { ...device, id: "use1/other-device", name: "Other computer" }],
    host: async (input) => {
      events.push("host-start")
      input.save({ clusterId: "use1", tunnelId: "hello-world", port: 1234 })
      return {
        device,
        stop: async () => {
          events.push("host-stop")
        },
      }
    },
    connect: async () => ({
      url: "http://127.0.0.1:12345",
      name: "Other computer",
      stop: async () => {
        events.push("client-stop")
      },
    }),
    ...overrides,
  })
  return { controller, settings, events }
}

describe("remote controller", () => {
  test("account sign-in leaves hosting off and never projects secrets", async () => {
    const input = fixture()
    const state = await input.controller.signIn()
    expect(state.account?.username).toBe("tester")
    expect(state.enabled).toBe(false)
    expect(input.events).toEqual(["save-credential"])
    expect(JSON.stringify(state)).not.toContain("private-")
    await input.controller.stop()
  })

  test("enable signs in, persists intent, and marks the confirmed current host", async () => {
    const input = fixture()
    const state = await input.controller.setEnabled(true)
    expect(state.status).toBe("online")
    expect(state.devices[0]).toMatchObject({ current: true, online: true })
    expect(input.settings.get("remoteEnabled")).toBe(true)
    await input.controller.stop()
    expect(input.events).toContain("host-stop")
  })

  test("disable stops only the host; sign-out closes remote clients and clears credentials", async () => {
    const input = fixture()
    await input.controller.setEnabled(true)
    await input.controller.connect("use1/other-device")
    const disabled = await input.controller.setEnabled(false)
    expect(disabled.account?.username).toBe("tester")
    expect(input.events).toContain("host-stop")
    expect(input.events).not.toContain("client-stop")
    const state = await input.controller.signOut()
    expect(input.events).toContain("client-stop")
    expect(input.events).toContain("clear-credential")
    expect(state).toMatchObject({ account: null, devices: [], enabled: false, status: "disabled" })
    await input.controller.stop()
  })

  test("sign-out invalidates a login queued in the same tick", async () => {
    const input = fixture()
    const login = input.controller.signIn()
    const logout = input.controller.signOut()
    await Promise.all([login, logout])
    expect(input.events).not.toContain("save-credential")
    expect((await input.controller.getState()).account).toBeNull()
    await input.controller.stop()
  })

  test("cancel interrupts active device polling without persisting a credential", async () => {
    const started = Promise.withResolvers<void>()
    const input = fixture({
      waitLogin: (_authorization, options) =>
        new Promise((_resolve, reject) => {
          started.resolve()
          options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
        }),
    })
    const login = input.controller.signIn()
    await started.promise
    expect((await input.controller.getState()).authorization?.userCode).toBe("ABCD-EFGH")
    await input.controller.cancelSignIn()
    await login
    expect(input.events).not.toContain("save-credential")
    expect((await input.controller.getState()).authorization).toBeNull()
    await input.controller.stop()
  })

  test("sign-out cancels an in-flight client and closes any late result", async () => {
    const connected = Promise.withResolvers<void>()
    const input = fixture({
      connect: async (_token, _id, signal) => {
        connected.resolve()
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
        return {
          url: "http://127.0.0.1:23456",
          name: "Other",
          stop: async () => {
            input.events.push("late-stop")
          },
        }
      },
    })
    await input.controller.signIn()
    const connection = input.controller.connect("use1/other-device").catch(() => undefined)
    await connected.promise
    await input.controller.signOut()
    await connection
    expect(input.events).toContain("late-stop")
    await input.controller.stop()
  })

  test("refresh recovers persisted account after a transient initialization failure", async () => {
    let requests = 0
    const input = fixture({
      credentials: {
        available: () => true,
        read: () => ({ accessToken: "stored-token" }),
        write: () => {},
        clear: () => {},
      },
      account: async () => {
        if (++requests === 1) throw new Error("network unavailable")
        return { id: 10, name: "Tester", username: "tester" }
      },
    })
    expect((await input.controller.initialize()).error).toBe("authentication")
    expect((await input.controller.refresh()).account?.username).toBe("tester")
    expect(requests).toBe(2)
    await input.controller.stop()
  })

  test("sign-out cannot let a late restored account repopulate renderer state", async () => {
    const started = Promise.withResolvers<void>()
    const identity = Promise.withResolvers<{ id: number; name: string; username: string }>()
    const accounts: unknown[] = []
    const input = fixture({
      credentials: {
        available: () => true,
        read: () => ({ accessToken: "stored-token" }),
        write: () => {},
        clear: () => {},
      },
      account: () => {
        started.resolve()
        return identity.promise
      },
      changed: (state) => accounts.push(state.account),
    })
    const initializing = input.controller.initialize()
    await started.promise
    const logout = input.controller.signOut()
    identity.resolve({ id: 10, name: "Tester", username: "tester" })
    await Promise.all([initializing, logout])
    expect(accounts.every((account) => account === null)).toBe(true)
    await input.controller.stop()
  })

  test("a queued connection is cancelled before opening any transport", async () => {
    let connections = 0
    const input = fixture({
      connect: async () => {
        connections++
        throw new Error("must not start")
      },
    })
    await input.controller.signIn()
    const connection = input.controller.connect("use1/other-device")
    const logout = input.controller.signOut()
    await expect(connection).rejects.toThrow("Remote connection unavailable")
    await logout
    expect(connections).toBe(0)
    await input.controller.stop()
  })

  test("late device listing after cancellation does not publish stale devices", async () => {
    const started = Promise.withResolvers<void>()
    const devices = Promise.withResolvers<Awaited<ReturnType<Parameters<typeof createRemoteController>[0]["list"]>>>()
    const visible: unknown[][] = []
    const input = fixture({
      list: () => {
        started.resolve()
        return devices.promise
      },
      changed: (state) => visible.push(state.devices),
    })
    const signingIn = input.controller.signIn()
    await started.promise
    const logout = input.controller.signOut()
    devices.resolve([
      {
        id: "use1/other-device",
        name: "Stale",
        online: true,
        url: null,
        port: 1234,
        clusterId: "use1",
        tunnelId: "other-device",
      },
    ])
    await Promise.all([signingIn, logout])
    expect(visible.every((devices) => devices.length === 0)).toBe(true)
    await input.controller.stop()
  })

  test("host recovery waits for the previous relay to finish stopping", async () => {
    const stopped = Promise.withResolvers<void>()
    const stopping = Promise.withResolvers<void>()
    const hosts: Parameters<Parameters<typeof createRemoteController>[0]["host"]>[0][] = []
    const input = fixture({
      host: async (options) => {
        hosts.push(options)
        return {
          device: {
            id: "use1/hello-world",
            name: "Host",
            online: true,
            url: null,
            port: 1234,
            clusterId: "use1",
            tunnelId: "hello-world",
          },
          stop: async () => {
            stopping.resolve()
            await stopped.promise
          },
        }
      },
    })
    await input.controller.setEnabled(true)
    hosts[0]!.changed("offline")
    await stopping.promise
    const refresh = input.controller.refresh()
    await Promise.resolve()
    expect(hosts).toHaveLength(1)
    stopped.resolve()
    expect((await refresh).status).toBe("online")
    expect(hosts).toHaveLength(2)
    hosts[0]!.changed("offline")
    expect((await input.controller.getState()).status).toBe("online")
    await input.controller.stop()
  })

  test("disabling while rename stops the host cannot restart sharing from the stale rename", async () => {
    const stopping = Promise.withResolvers<void>()
    const stopped = Promise.withResolvers<void>()
    let starts = 0
    const input = fixture({
      host: async () => {
        starts++
        return {
          device: {
            id: "use1/hello-world",
            name: "Host",
            online: true,
            url: null,
            port: 1234,
            clusterId: "use1",
            tunnelId: "hello-world",
          },
          stop: async () => {
            stopping.resolve()
            await stopped.promise
          },
        }
      },
    })
    await input.controller.setEnabled(true)
    const rename = input.controller.rename("New name")
    await stopping.promise
    const disable = input.controller.setEnabled(false)
    stopped.resolve()
    await Promise.all([rename, disable])
    expect(starts).toBe(1)
    expect((await input.controller.getState()).enabled).toBe(false)
    await input.controller.stop()
  })

  test("disconnected clients reconnect and duplicate old callbacks preserve the replacement", async () => {
    const disconnects: (() => void)[] = []
    const input = fixture({
      connect: async (_token, _id, _signal, disconnected) => {
        disconnects.push(disconnected)
        return { url: `http://127.0.0.1:${12000 + disconnects.length}`, name: "Remote", stop: async () => {} }
      },
    })
    await input.controller.signIn()
    const first = await input.controller.connect("use1/other-device")
    disconnects[0]!()
    const second = await input.controller.connect("use1/other-device")
    expect(second.url).not.toBe(first.url)
    disconnects[0]!()
    expect(await input.controller.connect("use1/other-device")).toEqual(second)
    expect(disconnects).toHaveLength(2)
    await input.controller.stop()
  })

  test("disconnect before client startup completes never caches a dead gateway", async () => {
    let stops = 0
    const input = fixture({
      connect: async (_token, _id, _signal, disconnected) => {
        disconnected()
        return {
          url: "http://127.0.0.1:12001",
          name: "Remote",
          stop: async () => {
            stops++
          },
        }
      },
    })
    await input.controller.signIn()
    await expect(input.controller.connect("use1/other-device")).rejects.toThrow()
    expect(stops).toBe(1)
    await input.controller.stop()
  })

  test("disabling sharing preserves a concurrent account token rotation", async () => {
    const renewed = Promise.withResolvers<{ accessToken: string }>()
    const tokens: (() => Promise<string>)[] = []
    const written: string[] = []
    let refreshes = 0
    const input = fixture({
      credentials: {
        available: () => true,
        read: () => undefined,
        clear: () => {},
        write: (credential) => {
          written.push(credential.accessToken)
        },
      },
      waitLogin: async () => ({ accessToken: "expired", expiresAt: 1, refreshToken: "refresh" }),
      refreshCredential: () => {
        refreshes++
        return renewed.promise
      },
      list: async (token) => {
        tokens.push(token)
        return []
      },
    })
    await input.controller.setEnabled(true)
    const first = tokens[0]!()
    const second = tokens[0]!()
    await input.controller.setEnabled(false)
    renewed.resolve({ accessToken: "rotated" })
    expect(await Promise.all([first, second])).toEqual(["rotated", "rotated"])
    expect(refreshes).toBe(1)
    expect(written).toContain("rotated")
    await input.controller.stop()
  })

  test("a token rotation finishing after sign-out cannot rewrite cleared credentials", async () => {
    const renewed = Promise.withResolvers<{ accessToken: string }>()
    const tokens: (() => Promise<string>)[] = []
    const written: string[] = []
    const input = fixture({
      credentials: {
        available: () => true,
        read: () => undefined,
        clear: () => {},
        write: (credential) => {
          written.push(credential.accessToken)
        },
      },
      waitLogin: async () => ({ accessToken: "expired", expiresAt: 1, refreshToken: "refresh" }),
      refreshCredential: () => renewed.promise,
      list: async (token) => {
        tokens.push(token)
        return []
      },
    })
    await input.controller.signIn()
    const token = tokens[0]!()
    await input.controller.signOut()
    renewed.resolve({ accessToken: "must-not-save" })
    await expect(token).rejects.toThrow("Authentication cancelled")
    expect(written).toEqual(["expired"])
    await input.controller.stop()
  })
})

test("disabling this host preserves an in-flight connection to another device", async () => {
  const started = Promise.withResolvers<void>()
  const ready = Promise.withResolvers<void>()
  const input = fixture({
    connect: async () => {
      started.resolve()
      await ready.promise
      return {
        url: "http://127.0.0.1:12345",
        name: "Other",
        stop: async () => {
          input.events.push("client-stop")
        },
      }
    },
  })
  await input.controller.setEnabled(true)
  const connection = input.controller.connect("use1/other-device")
  await started.promise
  const disabled = input.controller.setEnabled(false)
  ready.resolve()
  expect((await connection).url).toBe("http://127.0.0.1:12345")
  expect((await disabled).enabled).toBe(false)
  expect(input.events).not.toContain("client-stop")
  await input.controller.stop()
})

describe("remote credential storage", () => {
  test("unavailable or plaintext system backends refuse credential writes", () => {
    const stored = new Map<string, unknown>()
    const credentials = createRemoteCredentials({
      storage: {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => "basic_text",
        encryptString: () => {
          throw new Error("must not encrypt")
        },
        decryptString: () => "",
      },
      store: {
        get: (key) => stored.get(key),
        set: (key, value) => {
          stored.set(key, value)
        },
        delete: (key) => {
          stored.delete(key)
        },
      },
    })
    expect(credentials.available()).toBe(false)
    expect(() => credentials.write({ accessToken: "secret" })).toThrow()
    expect(stored.size).toBe(0)
  })
})
