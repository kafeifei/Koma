import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const STATE_FILE = "lab-build-sequence"
const LOCK_DIRECTORY = "lab-build-sequence.lock"
const LOCK_TIMEOUT_MS = 10_000
const RETRY_DELAY_MS = 10

export async function withKomaBuildSequence<T>(directory: string, build: (sequence: number) => Promise<T>) {
  await mkdir(directory, { recursive: true })
  const lockPath = join(directory, LOCK_DIRECTORY)
  const deadline = Date.now() + LOCK_TIMEOUT_MS

  await acquireLock(lockPath, deadline)
  try {
    const statePath = join(directory, STATE_FILE)
    const current = await readSequence(statePath)
    const next = current + 1
    if (!Number.isSafeInteger(next))
      throw new Error(`Koma build sequence exceeded the safe integer limit: ${statePath}`)

    // Keep the reservation exclusive until every requested build stage succeeds.
    const result = await build(next)
    const temporaryPath = join(directory, `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`)
    await writeFile(temporaryPath, `${next}\n`, { encoding: "utf8", flag: "wx" })
    await rename(temporaryPath, statePath)
    return result
  } finally {
    await rm(lockPath, { recursive: true, force: false })
  }
}

async function acquireLock(lockPath: string, deadline: number): Promise<void> {
  try {
    await mkdir(lockPath)
    return
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for Koma build sequence lock: ${lockPath}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, RETRY_DELAY_MS))
    return acquireLock(lockPath, deadline)
  }
}

async function readSequence(statePath: string) {
  let contents: string
  try {
    contents = await readFile(statePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0
    throw error
  }

  const value = contents.trim()
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`Invalid Koma build sequence state: ${statePath}`)
  const sequence = Number(value)
  if (!Number.isSafeInteger(sequence)) throw new Error(`Invalid Koma build sequence state: ${statePath}`)
  return sequence
}
