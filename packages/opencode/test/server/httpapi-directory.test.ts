import fs from "node:fs/promises"
import { join } from "node:path"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { createEmbeddedRoutes } from "@opencode-ai/server/routes"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  HttpRouter.serve(createEmbeddedRoutes(), { disableListenLog: true, disableLogger: true }).pipe(
    Layer.provide(layerWebSocketConstructorGlobal),
    Layer.provide(AppNodeBuilder.build(PermissionSaved.node)),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(NodeServices.layer),
  ),
)

function request(path: string) {
  const url = new URL("/api/directory", "http://localhost")
  url.searchParams.set("path", path)
  return HttpClientRequest.get(`${url.pathname}${url.search}`).pipe(HttpClient.execute)
}

it.live("lists one directory layer without a Location request", () =>
  Effect.gen(function* () {
    const temp = yield* tmpdirScoped()
    const folder = join(temp, "folder")
    yield* Effect.promise(() => fs.mkdir(folder))
    yield* Effect.promise(() =>
      Promise.all([
        fs.writeFile(join(temp, "note.txt"), "not read by the endpoint"),
        fs.symlink(folder, join(temp, "folder-link"), process.platform === "win32" ? "junction" : "dir"),
      ]),
    )

    const response = yield* request(temp)
    expect(response.status).toBe(200)
    const body = (yield* response.json) as {
      data: Array<{ name: string; path: string; type: "file" | "directory" }>
    }
    expect(body.data.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "folder", path: folder, type: "directory" },
      { name: "folder-link", path: join(temp, "folder-link"), type: "directory" },
      { name: "note.txt", path: join(temp, "note.txt"), type: "file" },
    ])
  }),
)

it.live("returns a public API error for a missing directory", () =>
  Effect.gen(function* () {
    const temp = yield* tmpdirScoped()
    const missing = join(temp, "missing")
    const response = yield* request(missing)

    expect(response.status).toBe(400)
    expect(yield* response.json).toMatchObject({
      _tag: "InvalidRequestError",
      kind: "directory",
      field: "path",
      message: expect.stringContaining("readDirectoryEntries"),
    })
  }),
)
