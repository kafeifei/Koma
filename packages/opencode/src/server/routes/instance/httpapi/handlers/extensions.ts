import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi, RootHttpApi } from "../api"
import { ExtensionError, ExtensionBusyError } from "../groups/extensions"
import { listPlugins, installPlugin, changePlugin } from "@/koma/extensions/plugins"
import { integrations, updateStore } from "@/koma/extensions/store"
import { InstanceState } from "@/effect/instance-state"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { SessionStatus } from "@/session/status"
import { catalog } from "@/koma/extensions/catalog"
import { installCatalogEntry } from "@/koma/extensions/install"
import type { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import { COMPUTER_USE_SERVER } from "@opencode-ai/core/koma-computer-use-types"

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) => new ExtensionError({ message: error instanceof Error ? error.message : String(error) }),
  })

export const pluginHandlers = HttpApiBuilder.group(RootHttpApi, "koma-plugins", (handlers) =>
  handlers
    .handle("catalog", () => attempt(() => catalog.get()))
    .handle("refreshCatalog", () => attempt(() => catalog.refresh()))
    .handle("installCatalog", ({ payload }) =>
      attempt(async () => {
        await installCatalogEntry(payload.id)
        return listPlugins()
      }),
    )
    .handle("list", () => attempt(listPlugins))
    .handle("install", ({ payload }) =>
      attempt(async () => {
        await installPlugin(payload)
        return listPlugins()
      }),
    )
    .handle("change", ({ payload }) =>
      attempt(async () => {
        await changePlugin(payload.id, payload)
        return listPlugins()
      }),
    )
    .handle("uninstall", ({ payload }) =>
      attempt(async () => {
        await changePlugin(payload.id)
        return listPlugins()
      }),
    )
    .handle("remove", ({ params }) =>
      attempt(async () => {
        await changePlugin(params.id)
        return listPlugins()
      }),
    ),
)

export const integrationHandlers = HttpApiBuilder.group(InstanceHttpApi, "koma-integrations", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const sessions = yield* SessionStatus.Service
    const list = Effect.fn("Extensions.integrations.list")(function* () {
      const directory = yield* InstanceState.directory
      const managed = yield* attempt(() => integrations(directory))
      const external = (yield* config.get()).mcp ?? {}
      const statuses = yield* mcp.status()
      return Object.entries({ ...managed, ...external }).flatMap(([name, cfg]) => {
        if (!("type" in cfg)) return []
        const status = statuses[name]
        return [
          {
            name,
            managed: !(name in external),
            enabled: cfg.enabled !== false,
            config: { ...cfg },
            status: status?.status ?? "disabled",
            ...(status && "error" in status ? { error: status.error } : {}),
          },
        ]
      })
    })
    const check = Effect.fn("Extensions.integrations.check")(function* (name: string) {
      if (name === COMPUTER_USE_SERVER)
        return yield* new ExtensionError({ message: "Manage computer control in Settings > Computer control." })
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name))
        return yield* new ExtensionError({
          message: "Use 1–80 letters, numbers, underscores or hyphens for the integration name.",
        })
      if (name in ((yield* config.get()).mcp ?? {}))
        return yield* new ExtensionError({ message: "This integration is managed by an existing configuration file." })
      return yield* Effect.void
    })
    const save = Effect.fn("Extensions.integrations.save")(function* (name: string, cfg: ConfigMCPV1.Info) {
      yield* check(name)
      if (cfg.type === "local" && (!cfg.command.length || !cfg.command[0]?.trim()))
        return yield* new ExtensionError({ message: "A local MCP server requires a command." })
      if (cfg.type === "remote") {
        const url = URL.parse(cfg.url)
        if (!url || !["http:", "https:"].includes(url.protocol))
          return yield* new ExtensionError({ message: "Enter an HTTP or HTTPS MCP endpoint." })
      }
      const directory = yield* InstanceState.directory
      // Persist first: a connection failure must remain visible and retryable.
      yield* attempt(() =>
        updateStore((s) => ({
          ...s,
          integrations: { ...s.integrations, [directory]: { ...s.integrations[directory], [name]: cfg } },
        })),
      )
      yield* mcp.add(name, cfg)
      return yield* list()
    })
    const remove = Effect.fn("Extensions.integrations.remove")(function* (name: string) {
      yield* check(name)
      const directory = yield* InstanceState.directory
      yield* attempt(() =>
        updateStore((s) => ({
          ...s,
          integrations: {
            ...s.integrations,
            [directory]: Object.fromEntries(
              Object.entries(s.integrations[directory] ?? {}).filter(([key]) => key !== name),
            ),
          },
        })),
      )
      yield* mcp.remove(name)
      return yield* list()
    })
    const idle = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
      sessions.whenIdle(operation).pipe(
        Effect.catchTag("SessionStatus.BusyError", () =>
          Effect.fail(
            new ExtensionBusyError({
              message: "This project has active tasks. Change its integrations after they finish.",
            }),
          ),
        ),
      )
    return handlers
      .handle("list", list)
      .handle("save", ({ payload }) => idle(save(payload.name, payload.config)))
      .handle("remove", ({ params }) => idle(remove(params.name)))
  }),
)
