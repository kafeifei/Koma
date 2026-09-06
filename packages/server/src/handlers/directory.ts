import { FSUtil } from "@opencode-ai/core/fs-util"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { InvalidRequestError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { isAbsolute, join } from "path"
import { Api } from "../api"

export const DirectoryHandler = HttpApiBuilder.group(Api, "server.directory", (handlers) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return handlers.handle(
      "directory.list",
      Effect.fn(function* (ctx) {
        if (!isAbsolute(ctx.query.path)) {
          return yield* new InvalidRequestError({
            message: "Directory path must be absolute",
            kind: "directory",
            field: "path",
          })
        }

        const entries = yield* fs.readDirectoryEntries(ctx.query.path).pipe(
          Effect.mapError(
            (error) =>
              new InvalidRequestError({
                message: error.message,
                kind: "directory",
                field: "path",
              }),
          ),
        )
        const listed = yield* Effect.all(
          entries.map((entry) => {
            const path = AbsolutePath.make(join(ctx.query.path, entry.name))
            if (entry.type === "file" || entry.type === "directory") {
              return Effect.succeed({ name: entry.name, path, type: entry.type })
            }
            if (entry.type !== "symlink") return Effect.succeed(undefined)
            return fs.stat(path).pipe(
              Effect.map((info) => {
                if (info.type === "File") return { name: entry.name, path, type: "file" as const }
                if (info.type === "Directory") return { name: entry.name, path, type: "directory" as const }
                return undefined
              }),
              Effect.catch(() => Effect.succeed(undefined)),
            )
          }),
          { concurrency: 8 },
        )
        return { data: listed.flatMap((entry) => (entry ? [entry] : [])) }
      }),
    )
  }),
)
