import { afterEach, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

const previous = process.env.XDG_STATE_HOME
delete process.env.XDG_STATE_HOME
const { backgroundStateCandidates } = await import("./background-state")

afterEach(() => {
  if (previous === undefined) delete process.env.XDG_STATE_HOME
  else process.env.XDG_STATE_HOME = previous
})

test("isolated CLI reads XDG state after module initialization", async () => {
  const state = join(tmpdir(), `opencode-lab-state-${process.pid}`)
  await mkdir(state, { recursive: true })
  process.env.XDG_STATE_HOME = state

  expect(backgroundStateCandidates("/formal/shell", "/formal/app-data", true)).toEqual([state])
  await rm(state, { recursive: true, force: true })
})

test("isolated CLI refuses to probe fallback state", () => {
  delete process.env.XDG_STATE_HOME
  expect(backgroundStateCandidates("/formal/shell", "/formal/app-data", true)).toEqual([])
})
