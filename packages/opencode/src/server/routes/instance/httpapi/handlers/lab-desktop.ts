import { desktopServiceRequest } from "@/koma/desktop-services"
import { KomaExperiments } from "@opencode-ai/core/koma-experiments"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { createKomaDraftStore } from "@opencode-ai/core/koma-draft-store"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Global } from "@opencode-ai/core/global"
import { StoragePaths } from "@opencode-ai/core/storage-paths"
import { createKomaDesktopStore } from "@opencode-ai/core/koma-desktop-store"
import { InvalidRequestError } from "../errors"
import { LabDesktopApi } from "../groups/lab-desktop"
import { createComputerUse } from "@opencode-ai/core/koma-computer-use"

export const labDesktopHandlers = HttpApiBuilder.group(LabDesktopApi, "lab-desktop", (handlers) => {
  const store = Global.Path.root ? createKomaDesktopStore(StoragePaths.resolve(Global.Path.root).desktop) : undefined
  let drafts: ReturnType<typeof createKomaDraftStore> | undefined
  const computerUse = Global.Path.root ? createComputerUse({ root: Global.Path.root }) : undefined
  return handlers
    .handle("computerUse", ({ payload }) =>
      Effect.tryPromise({
        try: () => {
          if (!process.env.KOMA_HOME || !computerUse) throw new Error("Computer control requires a Koma profile")
          return computerUse.request(payload)
        },
        catch: (error) => new InvalidRequestError({ message: error instanceof Error ? error.message : String(error) }),
      }),
    )
    .handle("storage", ({ payload }) =>
      Effect.tryPromise({
        try: () => {
          if (!process.env.KOMA_HOME || !store) throw new Error("Desktop storage requires a Koma profile")
          return store(payload)
        },
        catch: (error) =>
          new InvalidRequestError({ message: error instanceof Error ? error.message : "Desktop storage failed" }),
      }),
    )
    .handle("services", ({ payload }) =>
      Effect.tryPromise({
        try: () => desktopServiceRequest(payload),
        catch: (error) => new InvalidRequestError({ message: String(error) }),
      }),
    )
    .handle("experiments", ({ payload }) =>
      Effect.tryPromise({
        try: async () => {
          if (!process.env.KOMA_HOME || !Global.Path.root) throw new Error("Experiments require a Koma profile")
          const request = z.object({ enabled: z.boolean().optional() }).parse(payload)
          if (request.enabled !== undefined)
            await KomaExperiments.setBackgroundSubagents(Global.Path.root, request.enabled)
          return KomaExperiments.read(Global.Path.root)
        },
        catch: (error) => new InvalidRequestError({ message: String(error) }),
      }),
    )
    .handle("draft", ({ payload }) =>
      Effect.tryPromise({
        try: async () => {
          if (!process.env.KOMA_HOME || !Global.Path.root) throw new Error("Draft storage requires a Koma profile")
          const action = z
            .discriminatedUnion("op", [
              z.object({ op: z.literal("get"), key: z.string() }),
              z.object({ op: z.literal("set"), key: z.string(), value: z.string().nullable() }),
              z.object({ op: z.literal("putBlob"), data: z.string() }),
              z.object({ op: z.literal("getBlob"), id: z.string().regex(/^[a-f0-9]{64}$/) }),
            ])
            .parse(payload)
          if (!drafts) {
            const directory = StoragePaths.resolve(Global.Path.root).desktop
            mkdirSync(directory, { recursive: true })
            const SQLite = process.versions.bun
              ? (await import("bun:sqlite")).Database
              : (await import("node:sqlite")).DatabaseSync
            drafts = createKomaDraftStore(new SQLite(join(directory, "drafts.sqlite")))
          }
          if (action.op === "get") return drafts.get(action.key)
          if (action.op === "set") {
            drafts.set(action.key, action.value)
            return null
          }
          if (action.op === "putBlob") return drafts.putBlob(Buffer.from(action.data, "base64"))
          const blob = drafts.getBlob(action.id)
          return blob ? Buffer.from(blob).toString("base64") : null
        },
        catch: (error) =>
          new InvalidRequestError({ message: error instanceof Error ? error.message : "Draft storage failed" }),
      }),
    )
})
