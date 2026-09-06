import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"

export const DirectoryEntry = Schema.Struct({
  name: Schema.String,
  path: AbsolutePath,
  type: Schema.Literals(["file", "directory"]),
}).annotate({ identifier: "DirectoryEntry" })

export const DirectoryGroup = HttpApiGroup.make("server.directory")
  .add(
    HttpApiEndpoint.get("directory.list", "/api/directory", {
      query: Schema.Struct({ path: AbsolutePath }),
      success: Schema.Struct({ data: Schema.Array(DirectoryEntry) }),
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.directory.list",
        summary: "List a directory",
        description: "List the direct file and directory children of one absolute path.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "directories",
      description: "Global filesystem directory listing routes.",
    }),
  )
