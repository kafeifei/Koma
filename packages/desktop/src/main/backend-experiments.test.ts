import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LabEnvironment } from "@opencode-ai/core/lab-environment"
import { LabExperiments } from "@opencode-ai/core/lab-experiments"
import { createBackendExperiments } from "./backend-experiments"

test("saves the upstream startup flag without changing the running backend", async () => {
  const root = await mkdtemp(join(tmpdir(), "lab-experiments-"))
  const requests: string[] = []
  let active = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(`${request.method} ${new URL(request.url).pathname}`)
      expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("opencode:test").toString("base64")}`)
      return Response.json({ backgroundSubagents: active })
    },
  })
  const controller = createBackendExperiments({
    root,
    backend: async () => ({ url: server.url.href, username: "opencode", password: "test" }),
  })
  try {
    const inherited = { OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true" }
    LabEnvironment.prepare(inherited, root)
    expect(inherited.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS).toBe("true")
    expect(await controller.getState()).toEqual({ backgroundSubagents: false, runningBackgroundSubagents: false })
    expect(await controller.setBackgroundSubagents(true)).toEqual({
      backgroundSubagents: true,
      runningBackgroundSubagents: false,
    })
    const environment: NodeJS.ProcessEnv = { OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "false" }
    LabEnvironment.prepare(environment, root)
    expect(environment.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS).toBe("true")
    active = true
    expect(await controller.getState()).toEqual({ backgroundSubagents: true, runningBackgroundSubagents: true })
    expect(await controller.setBackgroundSubagents(false)).toEqual({
      backgroundSubagents: false,
      runningBackgroundSubagents: true,
    })
    LabEnvironment.prepare(environment, root)
    expect(environment.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS).toBe("false")
    expect(requests.every((request) => request === "GET /experimental/capabilities")).toBe(true)
  } finally {
    await server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})

test("invalid settings are reported without overwriting them", async () => {
  const root = await mkdtemp(join(tmpdir(), "lab-experiments-invalid-"))
  try {
    await LabExperiments.setBackgroundSubagents(root, true)
    const file = join(root, "config/experiments.json")
    await writeFile(file, '{"backgroundSubagents":"false"}')
    expect(() => LabExperiments.read(root)).toThrow("Invalid Lab experimental settings")
    await expect(LabExperiments.setBackgroundSubagents(root, false)).rejects.toThrow()
    expect(await readFile(file, "utf8")).toBe('{"backgroundSubagents":"false"}')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("unavailable backend does not make saved settings appear active", async () => {
  const root = await mkdtemp(join(tmpdir(), "lab-experiments-offline-"))
  try {
    const controller = createBackendExperiments({
      root,
      backend: async () => {
        throw new Error("offline")
      },
    })
    expect(await controller.setBackgroundSubagents(true)).toEqual({
      backgroundSubagents: true,
      runningBackgroundSubagents: null,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
