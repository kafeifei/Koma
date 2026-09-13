import { useNavigate } from "@solidjs/router"
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
import { DialogRemoteCleanup } from "./remote-cleanup"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
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
  | "cleanup"
  | `connect:${string}`

export function RemoteConnectionSettings(props: { remoteAccess: RemoteAccessPlatform }) {
  const language = useLanguage()
  const platform = usePlatform()
  const server = useServer()
  const navigate = useNavigate()
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
    if (!result || !server.add({ type: "http", displayName: result.name, http: { url: result.url } })) {
      setStore({ pending: null, actionError: true })
      return
    }
    navigate("/")
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

  const openRename = () => {
    let open = true
    return dialog.push(
      () => (
        <Dialog fit>
          <DialogHeader>
            <DialogTitle>{language.t("settings.remote.local.deviceName")}</DialogTitle>
          </DialogHeader>
          <DialogBody class="settings-v2-cleanup-body">
            <p>{language.t("settings.remote.local.deviceName.description")}</p>
            <TextInputV2
              value={store.deviceName}
              maxlength={40}
              disabled={!!store.pending}
              aria-label={language.t("settings.remote.local.deviceName")}
              onInput={(event) =>
                setStore({ deviceName: event.currentTarget.value, deviceNameDirty: true, actionError: false })
              }
            />
            <Show when={store.actionError}>
              <p role="alert">{language.t("settings.remote.error.action")}</p>
            </Show>
          </DialogBody>
          <DialogFooter>
            <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </ButtonV2>
            <ButtonV2
              variant="contrast"
              disabled={!!store.pending || !store.deviceName.trim()}
              onClick={async () => {
                await rename()
                if (open && !lifecycle.disposed && !store.actionError) dialog.close()
              }}
            >
              {language.t("common.save")}
            </ButtonV2>
          </DialogFooter>
        </Dialog>
      ),
      () => {
        open = false
        setStore({ deviceName: store.state?.deviceName ?? "", deviceNameDirty: false })
      },
    )
  }
  const cleanup = (selected?: string) =>
    dialog.push(() => (
      <DialogRemoteCleanup
        state={() => store.state}
        selected={selected}
        remove={async (ids) => {
          const request = ++lifecycle.request
          const subscription = lifecycle.subscription
          setStore({ pending: "cleanup", actionError: false })
          try {
            const result = await props.remoteAccess.remove(ids)
            if (!lifecycle.disposed && request === lifecycle.request && subscription === lifecycle.subscription)
              update(result.state)
            return result
          } finally {
            if (!lifecycle.disposed && request === lifecycle.request) setStore("pending", null)
          }
        }}
      />
    ))
  const confirm = (title: string, description: string, label: string, action: () => void) =>
    dialog.push(() => (
      <Dialog fit>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody class="settings-v2-cleanup-body">
          <p>{description}</p>
        </DialogBody>
        <DialogFooter>
          <ButtonV2 variant="neutral" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2
            variant="contrast"
            onClick={() => {
              dialog.close()
              action()
            }}
          >
            {label}
          </ButtonV2>
        </DialogFooter>
      </Dialog>
    ))
  const full = () =>
    store.state?.error === "capacity" || (!!store.state?.quota && store.state.quota.current >= store.state.quota.limit)
  return (
    <section class="settings-v2-section settings-v2-remote">
      <Show when={store.actionError}>
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
        fallback={<p class="settings-v2-remote-empty">{language.t("settings.remote.loading")}</p>}
      >
        {(state) => (
          <Show
            when={state().configured}
            fallback={<p class="settings-v2-remote-empty">{language.t("settings.remote.unavailable.description")}</p>}
          >
            <h3>{language.t("settings.remote.account.title")}</h3>
            <SettingsListV2>
              <SettingsRowV2
                title={store.state?.account?.name ?? language.t("settings.remote.account.title")}
                description={
                  store.state?.account
                    ? `@${store.state.account.username}`
                    : language.t("settings.remote.account.description")
                }
              >
                <Show when={store.state?.account} fallback={signedOutAccountAction()}>
                  <ButtonV2
                    variant="ghost-muted"
                    disabled={!!store.pending}
                    onClick={() =>
                      void confirm(
                        language.t("settings.remote.account.signOut"),
                        language.t("settings.remote.account.signOut.description"),
                        language.t("settings.remote.account.signOut"),
                        () => void runStateAction("sign-out", () => props.remoteAccess.signOut()),
                      )
                    }
                  >
                    {language.t("settings.remote.account.signOut")}
                  </ButtonV2>
                </Show>
              </SettingsRowV2>
              <SettingsRowV2
                title={language.t("settings.remote.local.enable.title")}
                description={
                  store.state?.account ? (
                    <div>
                      <p>{language.t("settings.remote.local.enable.description")}</p>
                      <div class="settings-v2-remote-host-meta">
                        <span class="settings-v2-remote-status" data-status={store.state?.status}>
                          <span aria-hidden="true" />
                          {statusLabel()}
                        </span>
                        <span>{store.state?.deviceName}</span>
                        <ButtonV2 variant="ghost-muted" disabled={!!store.pending} onClick={() => void openRename()}>
                          {language.t("settings.remote.rename")}
                        </ButtonV2>
                      </div>
                    </div>
                  ) : (
                    language.t("settings.remote.local.enable.signedOut")
                  )
                }
              >
                <Switch
                  hideLabel
                  checked={store.state?.enabled ?? false}
                  disabled={!!store.pending}
                  onChange={(enabled) => {
                    if (enabled) void runStateAction("enable", () => props.remoteAccess.setEnabled(true))
                    else
                      void confirm(
                        language.t("settings.remote.local.disable"),
                        language.t("settings.remote.local.disable.description"),
                        language.t("settings.remote.local.disable"),
                        () => void runStateAction("disable", () => props.remoteAccess.setEnabled(false)),
                      )
                  }}
                >
                  {language.t("settings.remote.local.enable.title")}
                </Switch>
              </SettingsRowV2>
            </SettingsListV2>
            <Show when={store.state?.authorization}>
              {(authorization) => (
                <section class="settings-v2-remote-authorization" aria-live="polite">
                  <h3>{language.t("settings.remote.authorization.title")}</h3>
                  <p>{language.t("settings.remote.authorization.description")}</p>
                  <TextInputV2
                    class="settings-v2-remote-code"
                    value={authorization().userCode}
                    readonly
                    showCopyButton
                    copyLabel={language.t("settings.remote.authorization.copy")}
                    onCopyClick={() => void copyAuthorizationCode()}
                  />
                  <div class="settings-v2-remote-authorization-actions">
                    <ButtonV2 variant="contrast" onClick={() => platform.openExternal(authorization().verificationUri)}>
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
                  <p>{language.t("settings.remote.authorization.waiting")}</p>
                  <p class="settings-v2-remote-authorization-attribution">
                    {language.t("settings.remote.authorization.attribution")}
                  </p>
                </section>
              )}
            </Show>
            <Show when={store.state?.account}>
              <div class="settings-v2-remote-quota" data-full={full()}>
                <span>
                  {language.t("settings.remote.quota.title")} ·{" "}
                  {store.state?.quota
                    ? `${store.state.quota.current} / ${store.state.quota.limit}`
                    : language.t("settings.remote.devices.unknown")}
                </span>
                <Show when={!store.state?.devicesError}>
                  <span>{language.t("settings.remote.quota.koma", { count: store.state?.devices.length ?? 0 })}</span>
                </Show>
              </div>
              <Show when={full()}>
                <div class="settings-v2-remote-alert" role="alert">
                  {language.t("settings.remote.quota.full")}
                  <ButtonV2
                    variant="ghost-muted"
                    disabled={!!store.pending || !!store.state?.devicesError}
                    onClick={() => void cleanup()}
                  >
                    {language.t("settings.remote.cleanup.title")}
                  </ButtonV2>
                </div>
              </Show>
            </Show>
            <div class="settings-v2-connection-subheading">
              <h3>{language.t("settings.connections.devices")}</h3>
              <div class="settings-v2-remote-actions">
                <ButtonV2
                  variant="ghost-muted"
                  disabled={!!store.pending}
                  onClick={() => void runStateAction("refresh", () => props.remoteAccess.refresh())}
                >
                  {language.t("settings.remote.refresh")}
                </ButtonV2>
                <Show when={store.state?.account}>
                  <ButtonV2
                    variant="neutral"
                    disabled={!!store.pending || !!store.state?.devicesError}
                    onClick={() => void cleanup()}
                  >
                    {language.t("settings.remote.cleanup.title")}
                  </ButtonV2>
                </Show>
              </div>
            </div>
            <Show
              when={store.state?.account}
              fallback={<p class="settings-v2-remote-empty">{language.t("settings.remote.devices.signedOut")}</p>}
            >
              <Show
                when={!store.state?.devicesError}
                fallback={
                  <p role="alert" class="settings-v2-remote-empty">
                    {language.t("settings.remote.cleanup.refreshRequired")}
                  </p>
                }
              >
                <Show
                  when={store.state?.devices.length}
                  fallback={<p class="settings-v2-remote-empty">{language.t("settings.remote.devices.empty")}</p>}
                >
                  <SettingsListV2>
                    <For each={store.state?.devices}>
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
                            <Show when={device.connectable === false}>
                              <span class="settings-v2-remote-service">
                                {language.t("settings.remote.devices.incomplete")}
                              </span>
                            </Show>
                          </span>
                          <Show
                            when={device.current}
                            fallback={
                              <Show
                                when={device.online === false && !device.connected}
                                fallback={
                                  <ButtonV2
                                    variant="neutral"
                                    disabled={!!store.pending || device.online !== true || device.connectable === false}
                                    onClick={() => void connect(device.id)}
                                  >
                                    {store.pending === `connect:${device.id}`
                                      ? language.t("settings.remote.devices.connecting")
                                      : device.connected
                                        ? language.t("settings.connections.openProjects")
                                        : language.t("settings.remote.devices.connect")}
                                  </ButtonV2>
                                }
                              >
                                <ButtonV2
                                  variant="ghost-muted"
                                  disabled={!!store.pending}
                                  aria-label={language.t("settings.remote.cleanup.device", { name: device.name })}
                                  onClick={() => void cleanup(device.id)}
                                >
                                  {language.t("common.delete")}
                                </ButtonV2>
                              </Show>
                            }
                          >
                            <Tag>{language.t("settings.connections.localDevice")}</Tag>
                          </Show>
                        </div>
                      )}
                    </For>
                  </SettingsListV2>
                </Show>
              </Show>
              <p class="settings-v2-remote-note">{language.t("settings.remote.cleanup.note")}</p>
            </Show>
          </Show>
        )}
      </Show>
      <Show when={store.state?.website}>
        {(website) => (
          <SettingsListV2>
            <SettingsRowV2
              title={language.t("settings.remote.local.website")}
              description={
                <>
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
                  <p>{language.t("settings.remote.website.description")}</p>
                </>
              }
            >
              <ButtonV2
                variant="ghost-muted"
                onClick={() => void navigator.clipboard.writeText(website()).catch(() => setStore("actionError", true))}
              >
                {language.t("settings.connections.copy")}
              </ButtonV2>
            </SettingsRowV2>
          </SettingsListV2>
        )}
      </Show>
      <p class="settings-v2-remote-service">
        {language.t("settings.remote.service")}
        <br />
        {language.t("settings.remote.cleanup.expiration")}
      </p>
    </section>
  )
}
