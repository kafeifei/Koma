import { PermissionModeError } from "@/utils/server-errors"
import { createEffect, createRoot, getOwner, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { Persist, persisted } from "@/utils/persist"
import type { ServerSDK } from "@/context/server-sdk"
import type { ServerSync } from "./server-sync"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import { type DraftTab, type PermissionMode, useTabs } from "./tabs"
import type { ServerScope } from "@/utils/server-scope"
import { ScopedKey } from "@/utils/server-scope"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { normalizeSessionInfo } from "@/utils/session"

function directoryAcceptKey(directory: string) {
  return `${base64Encode(directory)}/*`
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "default" || value === "auto" || value === "full"
}

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  gate: false,
  init: () => {
    const global = useGlobal()
    const server = useServer()
    const tabs = useTabs()
    const owner = getOwner()
    const states = new Map<ServerScope, { key: ServerConnection.Key; dispose: () => void; state: PermissionState }>()
    const [newSessionMode, setNewSessionMode] = createStore<Record<string, PermissionMode>>({})

    const ensure = (key: ServerConnection.Key) => {
      const conn = global.servers.list().find((item) => ServerConnection.key(item) === key)
      if (!conn) throw new Error(`Permission server not found: ${key}`)
      const ctx = global.ensureServerCtx(conn)
      const existing = states.get(ctx.sdk.scope)
      if (existing && global.servers.list().some((item) => ServerConnection.key(item) === existing.key)) {
        return existing.state
      }
      existing?.dispose()
      const root = createRoot(
        (dispose) => ({ key, dispose, state: createServerPermissionState({ sdk: ctx.sdk, sync: ctx.sync }) }),
        owner ?? undefined,
      )
      states.set(ctx.sdk.scope, root)
      return root.state
    }

    createEffect(() => global.servers.list().forEach((conn) => ensure(ServerConnection.key(conn))))
    createEffect(() => {
      const list = global.servers.list()
      const keys = new Set(list.map(ServerConnection.key))
      states.forEach((value, scope) => {
        if (keys.has(value.key)) return
        value.dispose()
        states.delete(scope)
      })
    })
    onCleanup(() => states.forEach((value) => value.dispose()))

    const stateForScope = (scope: ServerScope) => {
      const existing = states.get(scope)
      if (existing) return existing.state
      const conn = global.servers.list().find((item) => server.scope(ServerConnection.key(item)) === scope)
      if (!conn) throw new Error(`Permission server scope not found: ${scope}`)
      return ensure(ServerConnection.key(conn))
    }
    const draftTarget = (scope: ServerScope, directory: string, draftID?: string) => {
      if (!draftID) return
      const draft = tabs.store.find((item): item is DraftTab => item.type === "draft" && item.draftID === draftID)
      if (!draft || draft.directory !== directory || server.scope(draft.server) !== scope) return
      return draft
    }
    const newSessionKey = (scope: ServerScope, directory: string) => ScopedKey.from(scope, directory)

    return {
      ready(scope: ServerScope) {
        return stateForScope(scope).ready()
      },
      sessionReady(scope: ServerScope, sessionID: string) {
        return !!stateForScope(scope).sync.session.get(sessionID)
      },
      sessionMode(scope: ServerScope, sessionID: string) {
        return stateForScope(scope).sessionMode(sessionID)
      },
      setSessionMode(scope: ServerScope, sessionID: string, directory: string, mode: PermissionMode) {
        return stateForScope(scope).setSessionMode(sessionID, directory, mode)
      },
      newSessionMode(scope: ServerScope, directory: string, draftID?: string) {
        const draft = draftTarget(scope, directory, draftID)
        if (draft?.permissionMode) return draft.permissionMode
        const key = newSessionKey(scope, directory)
        if (!draft && newSessionMode[key]) return newSessionMode[key]
        return stateForScope(scope).directoryMode(directory)
      },
      setNewSessionMode(scope: ServerScope, directory: string, mode: PermissionMode, draftID?: string) {
        const draft = draftTarget(scope, directory, draftID)
        if (draft) {
          tabs.updateDraft(draft.draftID, { permissionMode: mode })
          return
        }
        setNewSessionMode(newSessionKey(scope, directory), mode)
      },
      newSessionReady: () => tabs.ready(),
      isAutoAcceptingDirectory(scope: ServerScope, directory: string) {
        return stateForScope(scope).directoryMode(directory) === "auto"
      },
      setDirectoryMode(scope: ServerScope, directory: string, mode: PermissionMode) {
        stateForScope(scope).setDirectoryMode(directory, mode)
      },
    }
  },
})

type PermissionState = ReturnType<typeof createServerPermissionState>

function createServerPermissionState(input: { sdk: ServerSDK; sync: ServerSync }) {
  const [store, setStore, _, ready] = persisted(
    {
      ...Persist.serverGlobal(input.sdk.scope, "permission", ["permission.v3"]),
      migrate(value) {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value
        const data = value as Record<string, unknown>
        const modes =
          data.directoryMode && typeof data.directoryMode === "object" && !Array.isArray(data.directoryMode)
            ? Object.fromEntries(
                Object.entries(data.directoryMode).filter((entry): entry is [string, PermissionMode] =>
                  isPermissionMode(entry[1]),
                ),
              )
            : {}
        return { ...data, directoryMode: modes }
      },
    },
    createStore({ directoryMode: {} as Record<string, PermissionMode> }),
  )

  return {
    ready: () => ready(),
    sessionMode(sessionID: string): PermissionMode {
      const mode = input.sync.session.get(sessionID)?.permissionMode
      return isPermissionMode(mode) ? mode : "default"
    },
    async setSessionMode(sessionID: string, directory: string, permissionMode: PermissionMode) {
      await input.sdk.api.session.setPermissionMode({
        sessionID,
        permissionMode,
        location: { directory },
      })
      const session = normalizeSessionInfo(await input.sdk.api.session.get({ sessionID }))
      if (session.permissionMode !== permissionMode) {
        throw new PermissionModeError("unconfirmed")
      }
      input.sync.session.remember(session)
      return session
    },
    directoryMode(directory: string): PermissionMode {
      return store.directoryMode[directoryAcceptKey(directory)] ?? "default"
    },
    setDirectoryMode(directory: string, mode: PermissionMode) {
      setStore("directoryMode", directoryAcceptKey(directory), mode)
    },
    sync: input.sync,
  }
}
