import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { Flock } from "./util/flock"

// Renderer preferences use the existing desktop files. Native credentials and
// host settings are deliberately outside this contract.
const name = z
  .string()
  .regex(/^(?:default|opencode\.(?:global|workspace\.[\w.-]+|window\.[\w.-]+|draft\.[\w.-]+))\.dat$/)
const request = z.discriminatedUnion("op", [
  z.object({ op: z.literal("read"), names: z.array(name).max(100) }),
  z.object({ op: z.literal("get"), name, key: z.string() }),
  z.object({ op: z.literal("set"), name, key: z.string(), value: z.string(), base: z.string().nullable().optional() }),
  z.object({ op: z.literal("remove"), name, key: z.string() }),
  z.object({ op: z.literal("clear"), name }),
  z.object({ op: z.literal("keys"), name }),
])
export type DesktopStoreRequest = z.infer<typeof request>
type Values = Record<string, string>

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function arrayKey(values: unknown[]) {
  if (values.every((value) => typeof value === "string")) return (value: any) => value as string
  for (const key of ["worktree", "id", "key"]) {
    if (values.every((value) => record(value) && typeof value[key] === "string"))
      return (value: any) => value[key] as string
  }
}

function applyChanges(base: unknown, next: unknown, current: unknown): unknown {
  if (JSON.stringify(base) === JSON.stringify(next)) return current
  if (Array.isArray(base) && Array.isArray(next) && Array.isArray(current)) {
    const key = arrayKey([...base, ...next, ...current])
    if (key) {
      const before = new Map(base.map((value) => [key(value), value]))
      const after = new Set(next.map(key))
      const live = new Map(current.map((value) => [key(value), value]))
      return [
        ...next
          .filter(
            (value) =>
              live.has(key(value)) ||
              !before.has(key(value)) ||
              JSON.stringify(value) !== JSON.stringify(before.get(key(value))),
          )
          .map((value) => applyChanges(before.get(key(value)), value, live.get(key(value)))),
        ...current.filter((value) => !before.has(key(value)) && !after.has(key(value))),
      ]
    }
  }
  if (!record(base) || !record(next) || !record(current)) return next
  const result = { ...current }
  for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (!(key in next)) delete result[key]
    else result[key] = applyChanges(base[key], next[key], current[key])
  }
  return result
}

export function createKomaDesktopStore(directory: string) {
  const read = async (name: string): Promise<Values> => {
    const raw = await readFile(join(directory, name), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}"
      throw error
    })
    const value: unknown = JSON.parse(raw)
    if (!record(value)) throw new Error("Invalid desktop preference file")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, value]) => value != null)
        .map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
    )
  }

  return async (input: unknown) => {
    const action = request.parse(input)
    if (action.op === "read")
      return Object.fromEntries(await Promise.all(action.names.map(async (name) => [name, await read(name)])))
    if (action.op === "get") return (await read(action.name))[action.key] ?? null
    if (action.op === "keys") return Object.keys(await read(action.name))
    await mkdir(directory, { recursive: true })
    return Flock.withLock(
      action.name,
      async () => {
        const values = await read(action.name)
        if (action.op === "clear") {
          await rm(join(directory, action.name), { force: true })
          return null
        }
        if (action.op === "remove") delete values[action.key]
        if (action.op === "set") {
          let value = action.value
          const current = values[action.key]
          if (action.base != null && current != null && current !== action.base) {
            try {
              value = JSON.stringify(applyChanges(JSON.parse(action.base), JSON.parse(value), JSON.parse(current)))
            } catch {
              /* Non-JSON values retain ordinary last-write semantics. */
            }
          }
          values[action.key] = value
        }
        const target = join(directory, action.name)
        const temporary = `${target}.${randomUUID()}.tmp`
        try {
          await writeFile(temporary, JSON.stringify(values, null, 2), { mode: 0o600, flag: "wx" })
          await rename(temporary, target)
        } finally {
          await rm(temporary, { force: true })
        }
        return action.op === "set" ? values[action.key] : null
      },
      { dir: join(directory, ".store-locks"), timeoutMs: 10_000, baseDelayMs: 5, maxDelayMs: 100 },
    )
  }
}
