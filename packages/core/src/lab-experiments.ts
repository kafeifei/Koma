import { readFileSync } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { StoragePaths } from "./storage-paths"

export function read(root: string): { backgroundSubagents?: boolean } {
  let text: string
  try {
    text = readFileSync(join(StoragePaths.resolve(root).config, "experiments.json"), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
  const value: unknown = JSON.parse(text)
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ("backgroundSubagents" in value && typeof value.backgroundSubagents !== "boolean")
  )
    throw new Error("Invalid Lab experimental settings")
  return value
}

export async function setBackgroundSubagents(root: string, enabled: boolean) {
  if (typeof enabled !== "boolean") throw new Error("Invalid background subagent preference")
  const directory = StoragePaths.resolve(root).config
  const file = join(directory, "experiments.json")
  const temporary = `${file}.${randomUUID()}.tmp`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporary, JSON.stringify({ ...read(root), backgroundSubagents: enabled }, null, 2), {
      mode: 0o600,
      flag: "wx",
    })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}

export * as LabExperiments from "./lab-experiments"
