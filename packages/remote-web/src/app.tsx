import { For, Match, Show, Switch, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { RemoteWebError, remoteWeb } from "./client"
import type { Account, Authorization, Device, PollResult, Session } from "./client"
import { createLanguage } from "./i18n"

type Screen = "loading" | "login" | "authorization" | "devices" | "error"

export function App() {
  const language = createLanguage()
  const [store, setStore] = createStore<{
    screen: Screen
    account?: Account
    authorization?: Authorization
    devices: Device[]
    pending: boolean
    error?: string
  }>({
    screen: "loading",
    devices: [],
    pending: false,
  })
  const lifecycle = {
    disposed: false,
    poll: 0,
    timer: undefined as number | undefined,
    request: undefined as Promise<PollResult> | undefined,
  }

  document.documentElement.lang = language.locale
  document.title = language.t("page.title")

  onMount(() => void loadSession())
  onCleanup(() => {
    lifecycle.disposed = true
    lifecycle.poll += 1
    if (lifecycle.timer !== undefined) window.clearTimeout(lifecycle.timer)
  })

  const loadSession = async () => {
    setStore({ screen: "loading", pending: true, error: undefined })
    const session = await remoteWeb.session().catch((error) => {
      showError(error)
      return undefined
    })
    if (!session || lifecycle.disposed) return
    applySession(session)
  }

  const applySession = (session: Session) => {
    if (!session.signedIn) {
      setStore({ screen: "login", account: undefined, devices: [], pending: false })
      return
    }
    setStore({
      screen: "devices",
      account: session.account,
      devices: session.devices,
      pending: false,
      error: undefined,
    })
  }

  const login = async () => {
    if (store.pending) return
    setStore({ pending: true, error: undefined })
    const authorization = await remoteWeb.login().catch((error) => {
      showError(error)
      return undefined
    })
    if (!authorization || lifecycle.disposed) return
    setStore({ screen: "authorization", authorization, pending: false })
    schedulePoll(authorization.interval)
  }

  const schedulePoll = (seconds: number) => {
    if (lifecycle.timer !== undefined) window.clearTimeout(lifecycle.timer)
    const generation = ++lifecycle.poll
    lifecycle.timer = window.setTimeout(
      () => {
        if (lifecycle.disposed || generation !== lifecycle.poll) return
        void poll()
      },
      Math.max(1, seconds) * 1_000,
    )
  }

  const poll = async () => {
    const authorization = store.authorization
    if (!authorization || store.screen !== "authorization") return
    if (Date.now() >= authorization.expiresAt) {
      setStore({ screen: "login", authorization: undefined, error: language.t("authorization.expired") })
      return
    }
    setStore({ pending: true, error: undefined })
    const generation = lifecycle.poll
    const request = remoteWeb.poll()
    lifecycle.request = request
    const result = await request.catch((error) => {
      if (lifecycle.disposed || generation !== lifecycle.poll) return
      setStore({ pending: false, error: errorMessage(error) })
      schedulePoll(authorization.interval)
      return undefined
    })
    if (lifecycle.request === request) lifecycle.request = undefined
    if (!result || lifecycle.disposed || generation !== lifecycle.poll) return
    applyPoll(result)
  }

  const applyPoll = (result: PollResult) => {
    if (result.status === "pending" || result.status === "slow_down") {
      setStore("pending", false)
      schedulePoll(result.retryAfter)
      return
    }
    lifecycle.poll += 1
    if (result.status === "denied" || result.status === "expired") {
      setStore({
        screen: "login",
        authorization: undefined,
        pending: false,
        error: language.t(result.status === "denied" ? "authorization.denied" : "authorization.expired"),
      })
      return
    }
    if (result.status !== "complete") return
    setStore({
      screen: "devices",
      account: result.account,
      authorization: undefined,
      devices: result.devices,
      pending: false,
      error: result.warning ? language.t("error.devices") : undefined,
    })
  }

  const cancelLogin = async () => {
    const generation = ++lifecycle.poll
    if (lifecycle.timer !== undefined) window.clearTimeout(lifecycle.timer)
    setStore("pending", true)
    await lifecycle.request?.catch(() => undefined)
    const result = await remoteWeb.logout().catch((error) => {
      if (!lifecycle.disposed && generation === lifecycle.poll) showError(error)
      return undefined
    })
    if (!result || lifecycle.disposed || generation !== lifecycle.poll) return
    setStore({ screen: "login", authorization: undefined, pending: false, error: undefined })
  }

  const logout = async () => {
    if (store.pending) return
    setStore("pending", true)
    const result = await remoteWeb.logout().catch((error) => {
      showError(error)
      return undefined
    })
    if (!result || lifecycle.disposed) return
    setStore({ screen: "login", account: undefined, authorization: undefined, devices: [], pending: false })
  }

  const refresh = async () => {
    if (store.pending) return
    setStore({ pending: true, error: undefined })
    const result = await remoteWeb.devices().catch((error) => {
      if (!lifecycle.disposed) setStore({ pending: false, error: errorMessage(error) })
      return undefined
    })
    if (!result || lifecycle.disposed) return
    setStore({ devices: result.devices, pending: false })
  }

  const showError = (error: unknown) => {
    if (lifecycle.disposed) return
    setStore({ screen: "error", pending: false, error: errorMessage(error) })
  }

  const errorMessage = (error: unknown) => {
    if (!(error instanceof RemoteWebError)) return language.t("error.generic")
    if (error.code === "configuration") return language.t("error.configuration")
    if (error.code === "authentication_required") return language.t("error.authentication")
    if (error.code === "github_unavailable") return language.t("error.github")
    if (error.code === "devices_unavailable") return language.t("error.devices")
    return language.t("error.generic")
  }

  const status = (device: Device) => {
    if (device.online === true) return language.t("devices.online")
    if (device.online === false) return language.t("devices.offline")
    return language.t("devices.unknown")
  }

  const openDevice = (device: Device) => {
    if (device.online !== true || !device.url) return
    window.location.assign(device.url)
  }

  return (
    <div class="remote-page">
      <header class="remote-header">
        <div class="remote-brand">
          <span class="remote-logo" aria-hidden="true">
            <Logo />
          </span>
          <span>Koma</span>
          <span class="remote-brand-label">{language.t("brand.remote")}</span>
        </div>
        <Show
          when={store.account}
          fallback={<span class="remote-workspace-label">{language.t("header.workspace")}</span>}
        >
          {(account) => (
            <div class="remote-account">
              <span class="remote-avatar" aria-hidden="true">
                {account().name.trim().charAt(0).toLocaleUpperCase() || "?"}
              </span>
              <span class="remote-account-name">{account().username}</span>
              <button class="remote-quiet" type="button" disabled={store.pending} onClick={() => void logout()}>
                {language.t("header.signOut")}
              </button>
            </div>
          )}
        </Show>
      </header>

      <main class="remote-main">
        <Switch>
          <Match when={store.screen === "loading"}>
            <section class="remote-centered">
              <Portal />
              <p class="remote-subtitle">{language.t("loading")}</p>
            </section>
          </Match>

          <Match when={store.screen === "login"}>
            <section class="remote-login">
              <Portal />
              <h1>{language.t("login.title")}</h1>
              <p class="remote-subtitle">{language.t("login.description")}</p>
              <Show when={store.error}>
                {(error) => (
                  <p class="remote-feedback" role="alert">
                    {error()}
                  </p>
                )}
              </Show>
              <button class="remote-primary" type="button" disabled={store.pending} onClick={() => void login()}>
                <GitHub />
                {store.pending ? language.t("login.pending") : language.t("login.action")}
              </button>
              <p class="remote-fine">{language.t("login.hint")}</p>
              <p class="remote-attribution">{language.t("login.attribution")}</p>
            </section>
          </Match>

          <Match when={store.screen === "authorization" && store.authorization}>
            <section class="remote-login remote-authorization">
              <GitHubSymbol />
              <h1>{language.t("authorization.title")}</h1>
              <p class="remote-subtitle">{language.t("authorization.description")}</p>
              <label for="remote-user-code">{language.t("authorization.code")}</label>
              <div class="remote-code-row">
                <input id="remote-user-code" value={store.authorization?.userCode ?? ""} readonly />
                <button
                  type="button"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(store.authorization?.userCode ?? "")
                      .catch(() => setStore("error", language.t("error.generic")))
                  }
                >
                  {language.t("authorization.copy")}
                </button>
              </div>
              <div class="remote-authorization-actions">
                <a href={store.authorization?.verificationUri} target="_blank" rel="noreferrer">
                  {language.t("authorization.open")}
                </a>
                <button class="remote-quiet" type="button" onClick={() => void cancelLogin()}>
                  {language.t("authorization.cancel")}
                </button>
              </div>
              <p class="remote-feedback" role="status">
                {store.error ?? language.t("authorization.waiting")}
              </p>
              <p class="remote-attribution">{language.t("login.attribution")}</p>
            </section>
          </Match>

          <Match when={store.screen === "devices"}>
            <section class="remote-devices">
              <div class="remote-heading">
                <div>
                  <h2>{language.t("devices.title")}</h2>
                  <p class="remote-subtitle">{language.t("devices.description")}</p>
                </div>
                <button class="remote-refresh" type="button" disabled={store.pending} onClick={() => void refresh()}>
                  {store.pending ? language.t("devices.refreshing") : language.t("devices.refresh")}
                </button>
              </div>
              <Show when={store.error}>
                {(error) => (
                  <p class="remote-feedback remote-devices-feedback" role="alert">
                    {error()}
                  </p>
                )}
              </Show>
              <Show
                when={store.devices.length > 0}
                fallback={
                  <div class="remote-empty">
                    <Computer />
                    <h2>{language.t("devices.empty.title")}</h2>
                    <p class="remote-subtitle">{language.t("devices.empty.description")}</p>
                  </div>
                }
              >
                <div class="remote-device-list">
                  <For each={store.devices}>
                    {(device) => (
                      <button
                        class="remote-device"
                        type="button"
                        disabled={device.online !== true || !device.url}
                        aria-label={`${device.name}, ${status(device)}`}
                        onClick={() => openDevice(device)}
                      >
                        <span class="remote-device-icon" aria-hidden="true">
                          <ComputerIcon />
                        </span>
                        <span class="remote-device-name">{device.name}</span>
                        <span class="remote-device-state" data-state={device.online === true ? "online" : "muted"}>
                          <span aria-hidden="true" />
                          {status(device)}
                        </span>
                        <span class="remote-arrow" aria-hidden="true">
                          ↗
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <details class="remote-help">
                <summary>{language.t("devices.help.title")}</summary>
                <p>{language.t("devices.help.description")}</p>
              </details>
            </section>
          </Match>

          <Match when={store.screen === "error"}>
            <section class="remote-centered">
              <Portal />
              <p class="remote-feedback" role="alert">
                {store.error}
              </p>
              <button class="remote-secondary" type="button" onClick={() => void loadSession()}>
                {language.t("error.retry")}
              </button>
            </section>
          </Match>
        </Switch>
      </main>

      <footer class="remote-footer">
        <span>{language.t("footer.connection")}</span>
        <span>{language.t("footer.execution")}</span>
      </footer>
    </div>
  )
}

function Logo() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7">
      <path d="m7 5-5 5 5 5m6-10 5 5-5 5" />
    </svg>
  )
}

function Portal() {
  return (
    <div class="remote-symbol" aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M7 26h10M12 21v5" />
        <rect x="22" y="14" width="8" height="13" rx="1.5" />
        <path d="M11 12h14m-4-4 4 4-4 4" />
      </svg>
    </div>
  )
}

function GitHubSymbol() {
  return (
    <div class="remote-symbol" aria-hidden="true">
      <GitHub />
    </div>
  )
}

function GitHub() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.24c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.16.08 1.78 1.2 1.78 1.2 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.74-1.55-2.57-.29-5.27-1.28-5.27-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.76 0c2.19-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.71 5.39-5.29 5.68.42.36.79 1.06.79 2.14v3.18c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  )
}

function Computer() {
  return (
    <div class="remote-symbol" aria-hidden="true">
      <ComputerIcon />
    </div>
  )
}

function ComputerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">
      <rect x="4" y="3" width="16" height="12" rx="2" />
      <path d="M8 20h8M12 15v5" />
    </svg>
  )
}
