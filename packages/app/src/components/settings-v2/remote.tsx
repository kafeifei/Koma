import { useDialog } from "@opencode-ai/ui/context/dialog"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { For, Show, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import type { RemoteAccessPlatform, RemoteAccessState } from "@/remote-access"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./remote.css"

type PendingAction =
  | "load"
  | "refresh"
  | "sign-in"
  | "sign-out"
  | "enable"
  | "disable"
  | "cancel-sign-in"
  | "rename"
  | `connect:${string}`

export function SettingsRemoteV2(props: { remoteAccess: RemoteAccessPlatform }) {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const dialog = useDialog()
  const [store, setStore] = createStore<{
    state?: RemoteAccessState
    pending: PendingAction | null
    actionError: boolean
    deviceName: string
    deviceNameDirty: boolean
  }>({
    pending: "load",
    actionError: false,
    deviceName: "",
    deviceNameDirty: false,
  })
  const lifecycle = { disposed: false, request: 0, subscription: 0 }

  const update = (state: RemoteAccessState, forceDeviceName = false) => {
    if (lifecycle.disposed) return
    setStore("state", state)
    if (forceDeviceName || !store.deviceNameDirty) setStore("deviceName", state.deviceName)
  }

  onMount(() => {
    const unsubscribe = props.remoteAccess.subscribe((state) => {
      lifecycle.subscription += 1
      update(state)
      if (store.pending === "load") setStore("pending", null)
    })
    const request = lifecycle.request
    const subscription = lifecycle.subscription
    void props.remoteAccess
      .getState()
      .then((state) => {
        if (lifecycle.disposed || request !== lifecycle.request || subscription !== lifecycle.subscription) return
        update(state)
        setStore("pending", null)
      })
      .catch(() => {
        if (lifecycle.disposed || request !== lifecycle.request || subscription !== lifecycle.subscription) return
        setStore({ pending: null, actionError: true })
      })
    onCleanup(() => {
      lifecycle.disposed = true
      lifecycle.request += 1
      unsubscribe()
    })
  })

  const runStateAction = async (
    pending: PendingAction,
    action: () => Promise<RemoteAccessState>,
    allowWhilePending = false,
  ) => {
    if (store.pending && !allowWhilePending) return
    const request = ++lifecycle.request
    const subscription = lifecycle.subscription
    setStore({ pending, actionError: false })
    const state = await action().catch(() => undefined)
    if (lifecycle.disposed || request !== lifecycle.request) return
    if (!state) {
      setStore({ pending: null, actionError: true })
      return
    }
    if (subscription !== lifecycle.subscription) {
      setStore("pending", null)
      return
    }
    update(state)
    setStore("pending", null)
  }

  const rename = async () => {
    if (store.pending || !store.state) return
    const name = store.deviceName.trim()
    if (!name || name === store.state.deviceName) {
      setStore({ deviceName: store.state.deviceName, deviceNameDirty: false })
      return
    }
    const request = ++lifecycle.request
    const subscription = lifecycle.subscription
    setStore({ pending: "rename", actionError: false })
    const state = await props.remoteAccess.rename(name).catch(() => undefined)
    if (lifecycle.disposed || request !== lifecycle.request) return
    if (subscription !== lifecycle.subscription) {
      const confirmed = store.state?.deviceName ?? ""
      setStore({
        pending: null,
        actionError: confirmed !== name,
        deviceName: confirmed,
        deviceNameDirty: false,
      })
      return
    }
    if (!state) {
      setStore({ pending: null, actionError: true })
      return
    }
    update(state, true)
    setStore({ pending: null, deviceNameDirty: false })
  }

  const connect = async (id: string) => {
    if (store.pending) return
    const request = ++lifecycle.request
    setStore({ pending: `connect:${id}`, actionError: false })
    const result = await props.remoteAccess.connect(id).catch(() => undefined)
    if (lifecycle.disposed || request !== lifecycle.request) return
    if (
      !result ||
      !server.add({ type: "http", displayName: result.name, http: { url: result.url }, remote: result.remote })
    ) {
      setStore({ pending: null, actionError: true })
      return
    }
    dialog.close()
  }

  const statusLabel = () => {
    if (store.state?.status === "connecting") return language.t("settings.remote.status.connecting")
    if (store.state?.status === "online") return language.t("settings.remote.status.online")
    if (store.state?.status === "offline") return language.t("settings.remote.status.offline")
    return language.t("settings.remote.status.disabled")
  }

  const backendError = () => {
    if (store.state?.error === "configuration") return language.t("settings.remote.error.configuration")
    if (store.state?.error === "authentication") return language.t("settings.remote.error.authentication")
    if (store.state?.error === "connection") return language.t("settings.remote.error.connection")
  }

  const otherDevices = () => store.state?.devices.filter((device) => !device.current) ?? []

  const copyAuthorizationCode = async () => {
    const code = store.state?.authorization?.userCode
    if (!code) return
    await navigator.clipboard.writeText(code).catch(() => setStore("actionError", true))
  }

  const signedOutAccountAction = () => {
    if (store.state?.authorization) return <span>{language.t("settings.remote.authorization.waiting")}</span>
    if (store.pending === "sign-in" || store.pending === "enable") {
      return (
        <ButtonV2
          variant="ghost-muted"
          onClick={() => void runStateAction("cancel-sign-in", () => props.remoteAccess.cancelSignIn(), true)}
        >
          {language.t("settings.remote.authorization.cancel")}
        </ButtonV2>
      )
    }
    return (
      <ButtonV2
        variant="neutral"
        disabled={!!store.pending}
        onClick={() => void runStateAction("sign-in", () => props.remoteAccess.signIn())}
      >
        {language.t("settings.remote.account.signIn")}
      </ButtonV2>
    )
  }

  return (
    <>
      <div class="settings-v2-tab-header settings-v2-remote-header">
        <div class="settings-v2-remote-heading">
          <h2 class="settings-v2-tab-title">{language.t("settings.remote.title")}</h2>
          <p>{language.t("settings.remote.description")}</p>
        </div>
        <ButtonV2
          size="normal"
          variant="ghost-muted"
          disabled={!!store.pending}
          onClick={() => void runStateAction("refresh", () => props.remoteAccess.refresh())}
        >
          {language.t("settings.remote.refresh")}
        </ButtonV2>
      </div>

      <div class="settings-v2-tab-body settings-v2-remote">
        <Show when={store.actionError && store.state}>
          <div class="settings-v2-remote-alert" role="alert">
            {language.t("settings.remote.error.action")}
          </div>
        </Show>
        <Show when={backendError()}>
          {(message) => (
            <div class="settings-v2-remote-alert" role="alert">
              {message()}
            </div>
          )}
        </Show>

        <Show
          when={store.state}
          fallback={
            <div class="settings-v2-remote-empty">
              {store.actionError ? language.t("settings.remote.error.action") : language.t("settings.remote.loading")}
            </div>
          }
        >
          {(state) => (
            <Show
              when={state().configured}
              fallback={
                <SettingsListV2>
                  <SettingsRowV2
                    title={language.t("settings.remote.unavailable.title")}
                    description={language.t("settings.remote.unavailable.description")}
                  >
                    <span />
                  </SettingsRowV2>
                </SettingsListV2>
              }
            >
              <>
                <section class="settings-v2-section">
                  <SettingsListV2>
                    <SettingsRowV2
                      title={
                        <Show when={store.state?.account} fallback={language.t("settings.remote.account.title")}>
                          {(account) => (
                            <span class="settings-v2-remote-account">
                              <span class="settings-v2-remote-avatar" aria-hidden="true">
                                {account().name.trim().charAt(0).toLocaleUpperCase() || "?"}
                              </span>
                              <span>{account().name}</span>
                            </span>
                          )}
                        </Show>
                      }
                      description={
                        <Show when={store.state?.account} fallback={language.t("settings.remote.account.description")}>
                          {(account) => (
                            <span>
                              {account().username} · {language.t("settings.remote.account.signedIn")}
                            </span>
                          )}
                        </Show>
                      }
                    >
                      <Show when={store.state?.account} fallback={signedOutAccountAction()}>
                        <ButtonV2
                          variant="ghost-muted"
                          disabled={!!store.pending}
                          onClick={() => void runStateAction("sign-out", () => props.remoteAccess.signOut())}
                        >
                          {store.pending === "sign-out"
                            ? language.t("settings.remote.account.signingOut")
                            : language.t("settings.remote.account.signOut")}
                        </ButtonV2>
                      </Show>
                    </SettingsRowV2>
                  </SettingsListV2>
                </section>

                <Show when={store.state?.authorization}>
                  {(authorization) => (
                    <section class="settings-v2-remote-authorization" aria-live="polite">
                      <div class="settings-v2-remote-authorization-copy">
                        <h3>{language.t("settings.remote.authorization.title")}</h3>
                        <p>{language.t("settings.remote.authorization.description")}</p>
                      </div>
                      <label>{language.t("settings.remote.authorization.code")}</label>
                      <TextInputV2
                        class="settings-v2-remote-code"
                        value={authorization().userCode}
                        readonly
                        showCopyButton
                        copyLabel={language.t("settings.remote.authorization.copy")}
                        onCopyClick={() => void copyAuthorizationCode()}
                      />
                      <div class="settings-v2-remote-authorization-actions">
                        <ButtonV2
                          variant="contrast"
                          onClick={() => platform.openExternal(authorization().verificationUri)}
                        >
                          {language.t("settings.remote.authorization.open")}
                        </ButtonV2>
                        <ButtonV2
                          variant="ghost-muted"
                          disabled={store.pending === "cancel-sign-in"}
                          onClick={() =>
                            void runStateAction("cancel-sign-in", () => props.remoteAccess.cancelSignIn(), true)
                          }
                        >
                          {language.t("settings.remote.authorization.cancel")}
                        </ButtonV2>
                      </div>
                      <p class="settings-v2-remote-authorization-waiting">
                        {language.t("settings.remote.authorization.waiting")}
                      </p>
                      <p class="settings-v2-remote-authorization-attribution">
                        {language.t("settings.remote.authorization.attribution")}
                      </p>
                    </section>
                  )}
                </Show>

                <section class="settings-v2-section">
                  <h3 class="settings-v2-section-title">{language.t("settings.remote.local.section")}</h3>
                  <SettingsListV2>
                    <SettingsRowV2
                      title={language.t("settings.remote.local.enable.title")}
                      description={
                        store.state?.account
                          ? language.t("settings.remote.local.enable.description")
                          : language.t("settings.remote.local.enable.signedOut")
                      }
                    >
                      <Switch
                        hideLabel
                        checked={store.state?.enabled ?? false}
                        disabled={!!store.pending}
                        onChange={(enabled) =>
                          void runStateAction(enabled ? "enable" : "disable", () =>
                            props.remoteAccess.setEnabled(enabled),
                          )
                        }
                      >
                        {language.t("settings.remote.local.enable.title")}
                      </Switch>
                    </SettingsRowV2>
                    <Show when={store.state?.enabled}>
                      <SettingsRowV2
                        title={language.t("settings.remote.local.deviceName")}
                        description={language.t("settings.remote.local.deviceName.description")}
                      >
                        <TextInputV2
                          class="settings-v2-remote-name"
                          value={store.deviceName}
                          maxlength={40}
                          disabled={!!store.pending}
                          aria-label={language.t("settings.remote.local.deviceName")}
                          onInput={(event) =>
                            setStore({
                              deviceName: event.currentTarget.value,
                              deviceNameDirty: true,
                              actionError: false,
                            })
                          }
                          onBlur={() => void rename()}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") return
                            event.currentTarget.blur()
                          }}
                        />
                      </SettingsRowV2>
                      <SettingsRowV2
                        title={language.t("settings.remote.local.status")}
                        description={
                          <span class="settings-v2-remote-status" data-status={store.state?.status}>
                            <span aria-hidden="true" />
                            {statusLabel()}
                          </span>
                        }
                      >
                        <span />
                      </SettingsRowV2>
                    </Show>
                    <Show when={store.state?.website}>
                      {(website) => (
                        <SettingsRowV2
                          title={language.t("settings.remote.local.website")}
                          description={
                            <a
                              class="settings-v2-remote-link"
                              href={website()}
                              onClick={(event) => {
                                event.preventDefault()
                                platform.openExternal(website())
                              }}
                            >
                              {website()}
                            </a>
                          }
                        >
                          <span />
                        </SettingsRowV2>
                      )}
                    </Show>
                  </SettingsListV2>
                  <p class="settings-v2-remote-note">
                    {store.state?.enabled
                      ? language.t("settings.remote.local.note.enabled")
                      : language.t("settings.remote.local.note.disabled")}
                  </p>
                </section>

                <section class="settings-v2-section">
                  <h3 class="settings-v2-section-title">{language.t("settings.remote.devices.section")}</h3>
                  <Show
                    when={store.state?.account}
                    fallback={
                      <div class="settings-v2-remote-empty">{language.t("settings.remote.devices.signedOut")}</div>
                    }
                  >
                    <Show
                      when={otherDevices().length}
                      fallback={
                        <div class="settings-v2-remote-empty">{language.t("settings.remote.devices.empty")}</div>
                      }
                    >
                      <SettingsListV2>
                        <For each={otherDevices()}>
                          {(device) => (
                            <div class="settings-v2-remote-device">
                              <span class="settings-v2-remote-device-icon" aria-hidden="true">
                                <Icon name="monitor" />
                              </span>
                              <span class="settings-v2-remote-device-copy">
                                <span class="settings-v2-remote-device-name">{device.name}</span>
                                <span
                                  class="settings-v2-remote-status"
                                  data-status={
                                    device.online === true ? "online" : device.online === false ? "offline" : "unknown"
                                  }
                                >
                                  <span aria-hidden="true" />
                                  {device.online === true
                                    ? language.t("settings.remote.devices.online")
                                    : device.online === false
                                      ? language.t("settings.remote.devices.offline")
                                      : language.t("settings.remote.devices.unknown")}
                                </span>
                              </span>
                              <ButtonV2
                                variant="neutral"
                                disabled={!!store.pending || device.online !== true}
                                onClick={() => void connect(device.id)}
                              >
                                {store.pending === `connect:${device.id}`
                                  ? language.t("settings.remote.devices.connecting")
                                  : device.online === false
                                    ? language.t("settings.remote.devices.offline")
                                    : device.online === null
                                      ? language.t("settings.remote.devices.unknown")
                                      : language.t("settings.remote.devices.connect")}
                              </ButtonV2>
                            </div>
                          )}
                        </For>
                      </SettingsListV2>
                    </Show>
                  </Show>
                </section>

                <p class="settings-v2-remote-service">{language.t("settings.remote.service")}</p>
              </>
            </Show>
          )}
        </Show>
      </div>
    </>
  )
}
