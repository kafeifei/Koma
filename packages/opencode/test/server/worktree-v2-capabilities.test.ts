import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { createEmbeddedRoutes } from "@opencode-ai/server/routes"
import { Effect, Layer } from "effect"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { HttpRouter } from "effect/unstable/http"
import { testEffect } from "../lib/effect"
import { request } from "./httpapi-layer"

const it = testEffect(
  HttpRouter.serve(createEmbeddedRoutes(), { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provide(layerWebSocketConstructorGlobal),
    Layer.provide(AppNodeBuilder.build(PermissionSaved.node)),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(NodeServices.layer),
  ),
)

it.live("standalone V2 explicitly reports lifecycle management as unsupported", () =>
  Effect.gen(function* () {
    const capabilities = yield* request("/api/session/capabilities")
    expect(capabilities.status).toBe(200)
    expect(yield* capabilities.json).toEqual({
      data: {
        archive: false,
        restore: false,
        delete: false,
        managedWorktree: false,
        occupancy: { pty: false, v2: false, externalProcesses: false },
      },
    })
    const archived = yield* request("/api/session/ses_unmanaged/archive", { method: "POST" })
    expect(archived.status).toBe(503)
    expect(yield* archived.json).toMatchObject({ _tag: "ServiceUnavailableError", service: "session.lifecycle" })
  }),
)
