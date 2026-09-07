import type { RemoteAccessState } from "@opencode-ai/app/remote-access"
import type { GitHubCredential, getGitHubAccount, beginGitHubLogin, waitGitHubLogin } from "@opencode-ai/remote/github"
import type { RemoteTunnelDevice } from "@opencode-ai/remote/tunnels"
import type { RemoteHostRecord } from "./remote-host"

type Account = Awaited<ReturnType<typeof getGitHubAccount>>
type Connection = { stop(): Promise<void> }
type Dependencies = {
  credentials: {
    available(): boolean
    read(): GitHubCredential | undefined
    write(value: GitHubCredential): void
    clear(): void
  }
  settings: { get(key: string): unknown; set(key: string, value: unknown): void }
  deviceID: string
  deviceName: string
  website: string | null
  changed(state: RemoteAccessState): void
  login: typeof beginGitHubLogin
  waitLogin: typeof waitGitHubLogin
  account(token: string): Promise<Account>
  refreshCredential(value: GitHubCredential): Promise<GitHubCredential>
  list(token: () => Promise<string>): Promise<RemoteTunnelDevice[]>
  host(options: {
    token(): Promise<string>
    accountID: number
    deviceID: string
    name: string
    record?: RemoteHostRecord
    signal: AbortSignal
    save(record: RemoteHostRecord): void
    changed(status: "connecting" | "online" | "offline"): void
  }): Promise<Connection & { device: RemoteTunnelDevice }>
  connect(
    token: () => Promise<string>,
    id: string,
    signal: AbortSignal,
    disconnected: () => void,
  ): Promise<Connection & { url: string; name: string }>
}

export function createRemoteController(deps: Dependencies) {
  let state: RemoteAccessState = {
    configured: deps.credentials.available(),
    account: null,
    authorization: null,
    enabled: deps.settings.get("remoteEnabled") === true,
    status: "disabled",
    deviceName:
      typeof deps.settings.get("remoteDeviceName") === "string"
        ? String(deps.settings.get("remoteDeviceName"))
        : deps.deviceName,
    website: deps.website,
    devices: [],
    error: null,
  }
  let credential: GitHubCredential | undefined
  let account: Account | undefined
  let host: Connection | undefined
  let login: AbortController | undefined
  let hosting: AbortController | undefined
  let lifetime = new AbortController()
  let revision = 0
  let authentication = 0
  let disposed = false
  let refresh: { generation: number; promise: Promise<GitHubCredential> } | undefined
  let hostStopping = Promise.resolve()
  let pending = Promise.resolve()
  let timer: ReturnType<typeof setInterval> | undefined
  const clients = new Map<string, Connection & { url: string; name: string }>()
  const publish = (patch: Partial<RemoteAccessState>) => {
    state = { ...state, ...patch }
    if (!disposed) deps.changed(state)
    return state
  }
  const check = (generation: number) => {
    if (disposed || generation !== revision) throw new Error("Remote operation cancelled")
  }
  const token = async () => {
    if (!credential || disposed) throw new Error("Authentication required")
    if (!credential.expiresAt || credential.expiresAt > Date.now() + 60_000) return credential.accessToken
    const generation = authentication
    if (!refresh || refresh.generation !== generation) {
      const promise = deps.refreshCredential(credential).finally(() => {
        if (refresh?.promise === promise) refresh = undefined
      })
      refresh = { generation, promise }
    }
    const next = await refresh.promise
    if (disposed || generation !== authentication) throw new Error("Authentication cancelled")
    deps.credentials.write(next)
    credential = next
    return next.accessToken
  }
  const records = () => {
    const value = deps.settings.get("remoteTunnels")
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, RemoteHostRecord>)
      : {}
  }
  const currentID = () => {
    const record = account ? records()[String(account.id)] : undefined
    return record ? `${record.clusterId}/${record.tunnelId}` : undefined
  }
  const haltHost = async () => {
    hosting?.abort()
    hosting = undefined
    const previous = host
    host = undefined
    hostStopping = Promise.allSettled([hostStopping, previous?.stop()]).then(() => undefined)
    await hostStopping
  }
  const halt = async () => {
    lifetime.abort()
    await Promise.allSettled([haltHost(), ...Array.from(clients.values(), (client) => client.stop())])
    clients.clear()
    lifetime = new AbortController()
  }
  const restoreAccount = async (generation: number) => {
    check(generation)
    if (account) return
    credential ??= deps.credentials.read()
    if (!credential) return
    const identity = await deps.account(await token())
    check(generation)
    account = identity
    publish({ account: { name: identity.name, username: identity.username }, error: null })
  }
  const list = async (generation: number) => {
    check(generation)
    if (!account) return state
    const devices = await deps.list(token)
    check(generation)
    return publish({
      devices: devices.map((device) => ({
        id: device.id,
        name: device.name,
        current: device.id === currentID(),
        online: device.id === currentID() ? state.status === "online" : device.online,
      })),
    })
  }
  const ensureHost = async (generation: number) => {
    await hostStopping
    check(generation)
    if (!state.enabled || !account || host) return
    const identity = account
    const controller = new AbortController()
    hosting = controller
    publish({ status: "connecting", error: null })
    const result = await deps.host({
      token,
      accountID: identity.id,
      deviceID: deps.deviceID,
      name: state.deviceName,
      record: records()[String(identity.id)],
      signal: controller.signal,
      save: (record) => {
        if (controller.signal.aborted || disposed || generation !== revision) return
        deps.settings.set("remoteTunnels", { ...records(), [String(identity.id)]: record })
      },
      changed: (status) => {
        if (controller.signal.aborted || disposed || hosting !== controller) return
        publish({
          status,
          devices: state.devices.map((device) =>
            device.current ? { ...device, online: status === "online" } : device,
          ),
        })
        if (status === "offline") void haltHost()
      },
    })
    if (controller.signal.aborted || disposed || generation !== revision) {
      await result.stop()
      check(generation)
      throw new Error("Remote host disconnected")
    }
    host = result
    publish({ status: "online", error: null })
  }
  const authenticate = async (generation: number) => {
    check(generation)
    if (account) return
    if (!deps.credentials.available()) throw new Error("Credential storage unavailable")
    const controller = new AbortController()
    login = controller
    try {
      const authorization = await deps.login({ signal: controller.signal })
      controller.signal.throwIfAborted()
      publish({
        authorization: {
          userCode: authorization.userCode,
          verificationUri: authorization.verificationUri,
          expiresAt: authorization.expiresAt,
        },
        error: null,
      })
      const next = await deps.waitLogin(authorization, { signal: controller.signal })
      const identity = await deps.account(next.accessToken)
      controller.signal.throwIfAborted()
      check(generation)
      deps.credentials.write(next)
      credential = next
      account = identity
      publish({ account: { name: identity.name, username: identity.username }, authorization: null })
    } finally {
      if (login === controller) login = undefined
      if (generation === revision) publish({ authorization: null })
    }
  }
  const run = (action: (generation: number) => Promise<unknown>, error: RemoteAccessState["error"] = "connection") => {
    const generation = revision
    const result = pending.then(async () => {
      if (disposed || generation !== revision) return state
      try {
        await action(generation)
      } catch {
        if (disposed || generation !== revision) return state
        publish({ error, status: state.enabled ? (host ? state.status : "offline") : "disabled" })
      }
      return state
    })
    pending = result.then(() => undefined)
    return result
  }
  return {
    getState: async () => state,
    initialize: () => {
      if (disposed) return Promise.resolve(state)
      timer ??= setInterval(() => {
        void run(async (generation) => {
          await restoreAccount(generation)
          await ensureHost(generation)
          await list(generation)
        })
      }, 30_000)
      timer.unref?.()
      return run(async (generation) => {
        await restoreAccount(generation)
        if (account) {
          await ensureHost(generation)
          await list(generation)
        } else if (state.enabled) publish({ status: "offline", error: "authentication" })
      }, "authentication")
    },
    signIn: () =>
      run(async (generation) => {
        await authenticate(generation)
        check(generation)
        await ensureHost(generation)
        await list(generation)
      }, "authentication"),
    cancelSignIn: () => {
      revision++
      login?.abort()
      return run(async () => {
        publish({ authorization: null, error: null })
      })
    },
    signOut: () => {
      revision++
      authentication++
      login?.abort()
      hosting?.abort()
      lifetime.abort()
      return run(async () => {
        await halt()
        deps.credentials.clear()
        deps.settings.set("remoteEnabled", false)
        credential = undefined
        account = undefined
        publish({ account: null, authorization: null, enabled: false, status: "disabled", devices: [], error: null })
      })
    },
    setEnabled: (enabled: boolean) => {
      if (!enabled) {
        revision++
        login?.abort()
        hosting?.abort()
      }
      return run(async (generation) => {
        if (!enabled) {
          deps.settings.set("remoteEnabled", false)
          await haltHost()
          publish({
            enabled: false,
            status: "disabled",
            error: null,
            devices: state.devices.map((device) => (device.current ? { ...device, online: false } : device)),
          })
          return
        }
        await authenticate(generation)
        check(generation)
        deps.settings.set("remoteEnabled", true)
        publish({ enabled: true })
        await ensureHost(generation)
        await list(generation)
      })
    },
    rename: (name: string) =>
      run(async (generation) => {
        if (!name.trim() || name.trim().length > 40) throw new Error("Invalid device name")
        deps.settings.set("remoteDeviceName", name.trim())
        publish({ deviceName: name.trim() })
        await haltHost()
        await ensureHost(generation)
        await list(generation)
      }),
    refresh: () =>
      run(async (generation) => {
        await restoreAccount(generation)
        if (!account) {
          if (state.enabled) publish({ status: "offline", error: "authentication" })
          return
        }
        await ensureHost(generation)
        await list(generation)
        publish({ error: null })
      }),
    connect: (id: string) => {
      const generation = authentication
      const result = pending
        .then(async () => {
          if (disposed || generation !== authentication) throw new Error("Remote connection cancelled")
          if (!account || disposed || id === currentID()) throw new Error("Remote connection unavailable")
          const existing = clients.get(id)
          if (existing) return { url: existing.url, name: existing.name }
          const signal = lifetime.signal
          let disconnected = false
          const client = await deps.connect(token, id, signal, () => {
            if (disconnected) return
            disconnected = true
            if (!signal.aborted) clients.delete(id)
          })
          if (signal.aborted || disposed || generation !== authentication || disconnected) {
            await client.stop()
            throw new Error("Remote connection cancelled")
          }
          clients.set(id, client)
          return { url: client.url, name: client.name }
        })
        .catch(() => {
          throw new Error("Remote connection unavailable")
        })
      pending = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
    stop: async () => {
      disposed = true
      revision++
      authentication++
      if (timer) clearInterval(timer)
      login?.abort()
      hosting?.abort()
      lifetime.abort()
      await halt()
      await pending
    },
  }
}
