import { expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { StorageMigration } from "@opencode-ai/core/storage-migration"

async function fixture(shared?: "fresh" | "legacy") {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "lab-backend-flow-")))
  await Promise.all(["home", "tmp", "project"].map((name) => mkdir(path.join(base, name))))
  const project = path.join(base, "project")
  const root = shared
    ? path.join(base, "home", shared === "legacy" ? ".opencode" : ".koma")
    : path.join(base, "profile")
  if (shared === "legacy") {
    const legacyRoot = path.join(base, "home/Library/Application Support/OpenCode Lab")
    await mkdir(legacyRoot, { recursive: true })
    StorageMigration.prepareUnifiedHome({ root, legacyRoot, acquireLock: () => true })
  }
  const env = {
    PATH: process.env.PATH,
    HOME: path.join(base, "home"),
    TMPDIR: path.join(base, "tmp"),
    XDG_DATA_HOME: path.join(base, "xdg-data"),
    XDG_CONFIG_HOME: path.join(base, "xdg-config"),
    XDG_CACHE_HOME: path.join(base, "xdg-cache"),
    XDG_STATE_HOME: path.join(base, "xdg-state"),
    ...(shared ? { KOMA_RELEASE: "1" } : { OPENCODE_HOME: root }),
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_EXTERNAL_SERVICES: "1",
    GIT_CONFIG_NOSYSTEM: "1",
  }
  // Exercise the same flow against a packaged Lab executable when one is supplied.
  const command = process.env.OPENCODE_LAB_TEST_BINARY
    ? [path.resolve(process.env.OPENCODE_LAB_TEST_BINARY)]
    : [process.execPath, path.join(import.meta.dir, "../../src/koma.ts")]
  const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = []
  const spawn = (args: string[], instance = "electron") => {
    const child = Bun.spawn(args, {
      cwd: project,
      env: { ...env, KOMA_BACKEND_INSTANCE: instance },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    children.push(child)
    return child
  }
  const run = async (args: string[], instance = "electron") => {
    const child = spawn(args, instance)
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000)
    const result = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timeout))
    expect(result[0], result.slice(1).join("\n")).toBe(0)
    return result[1]
  }
  const target = { file: "" }
  const requests: Array<{ messages: Array<{ role: string }> }> = []
  // Only the remote model is a fixture. Session execution, tools, permissions,
  // SQLite, Git and every client request use the actual backend implementation.
  const model = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as (typeof requests)[number]
      requests.push(body)
      const done = body.messages.some((message) => message.role === "tool")
      const delta = done
        ? { role: "assistant", content: "Backend completed the write." }
        : {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_write",
                type: "function",
                function: {
                  name: "write",
                  arguments: JSON.stringify({ filePath: target.file, content: "written by the backend" }),
                },
              },
            ],
          }
      const chunk = { id: "test", object: "chat.completion.chunk", created: 1, model: "test" }
      const chunks = [
        { ...chunk, choices: [{ index: 0, delta, finish_reason: null }] },
        {
          ...chunk,
          choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "tool_calls" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      ]
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      })
    },
  })
  return {
    root,
    project,
    target,
    requests,
    model,
    run,
    start: (instance = "electron") => spawn([...command, "backend", "serve"], instance),
    cli: (args: string[], instance = "electron") => run([...command, ...args], instance),
    async [Symbol.asyncDispose]() {
      // Cleanup authority comes from the subprocess handles we created, never a profile PID record.
      await Promise.all(
        children.map(async (child) => {
          if (child.exitCode !== null) return
          child.kill("SIGTERM")
          const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000)
          await child.exited.finally(() => clearTimeout(timeout))
        }),
      )
      await model.stop(true)
      await rm(base, { recursive: true, force: true })
    },
  }
}

async function until<T>(label: string, read: () => Promise<T | undefined>) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(50)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function sharedBackends(shared: "fresh" | "legacy") {
  await using input = await fixture(shared)
  const connections = new Map<string, { pid: number; url: string; username: string; password: string }>()
  for (const instance of ["electron", "tauri"]) {
    const backend = input.start(instance)
    // Drain both streams while the process runs so startup cannot block on logs.
    void new Response(backend.stdout).text()
    void new Response(backend.stderr).text()
    const connection = await until(`${instance} connection`, async () => {
      if (backend.exitCode !== null) throw new Error(`${instance} exited: ${backend.exitCode}`)
      const directory = instance === "electron" ? ".koma-backend" : `.koma-instances/${instance}`
      const file = Bun.file(path.join(input.root, "bin", directory, "backend.json"))
      if (!(await file.exists())) return
      const value = await file.json()
      if (value.url) return value
    })
    connections.set(instance, connection)
    expect(connection.pid).toBe(backend.pid)
  }
  const a = connections.get("electron")!
  const b = connections.get("tauri")!
  expect(a.pid).not.toBe(b.pid)
  expect(a.url).not.toBe(b.url)
  expect(a.password).not.toBe(b.password)
  const call = async (instance: string, route: string, method = "GET", body?: unknown) => {
    const connection = connections.get(instance)!
    const response = await fetch(new URL(route, connection.url), {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
        "Content-Type": "application/json",
        "x-opencode-directory": encodeURIComponent(input.project),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    const value = await response.json()
    expect(response.status, JSON.stringify(value)).toBe(200)
    return value
  }
  const first = await call("electron", "/session", "POST", { title: "Created by Electron" })
  expect((await call("tauri", `/session/${first.id}`)).title).toBe("Created by Electron")
  await call("tauri", `/session/${first.id}`, "PATCH", { title: "Renamed by Tauri" })
  expect((await call("electron", `/session/${first.id}`)).title).toBe("Renamed by Tauri")
  const created = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      call(i % 2 ? "electron" : "tauri", "/session", "POST", { title: `Concurrent ${i}` }),
    ),
  )
  expect(new Set(created.map((session) => session.id)).size).toBe(10)
  for (const session of created) {
    expect((await call("electron", `/session/${session.id}`)).id).toBe(session.id)
    expect((await call("tauri", `/session/${session.id}`)).id).toBe(session.id)
  }
  const pathsA = JSON.parse(await input.cli(["backend", "paths"]))
  const pathsB = JSON.parse(await input.cli(["backend", "paths"], "tauri"))
  expect(pathsA.distribution).toBe("release")
  expect(pathsA.profile).toBe(input.root)
  expect(pathsA.profile).toBe(pathsB.profile)
  expect(pathsA.state).not.toBe(pathsB.state)
  await input.cli(["backend", "stop"], "tauri")
  expect((await call("electron", "/global/health")).healthy).toBe(true)
  const continued = await call("electron", "/session", "POST", { title: "After Tauri stopped" })
  expect((await call("electron", `/session/${continued.id}`)).title).toBe("After Tauri stopped")
  await input.cli(["backend", "stop"])
}

test.each(["fresh", "legacy"] as const)(
  "release backends share %s default data and survive the other instance stopping",
  sharedBackends,
  120_000,
)

test("backend survives CLI exit, gates real writes and preserves files through worktree archive and restore", async () => {
  await using input = await fixture()
  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
    ["commit", "--allow-empty", "-qm", "fixture"],
  ])
    await input.run(["git", ...args])
  const backend = input.start()
  const logs = Promise.all([new Response(backend.stdout).text(), new Response(backend.stderr).text()])
  try {
    const connection = await until("published backend connection", async () => {
      if (backend.exitCode !== null) throw new Error(`Backend exited with ${backend.exitCode}`)
      const file = Bun.file(path.join(input.root, "bin/.koma-backend/backend.json"))
      if (!(await file.exists())) return
      const value = (await file.json()) as { pid: number; url?: string; username: string; password: string }
      if (value.url) return { ...value, url: value.url }
    })
    expect(connection.pid).toBe(backend.pid)
    const call = (url: string, directory = input.project, method = "GET", body?: unknown) =>
      fetch(new URL(url, connection.url), {
        method,
        headers: {
          Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`,
          "Content-Type": "application/json",
          "x-opencode-directory": encodeURIComponent(directory),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      })
    const configure = await call("/global/config", input.project, "PATCH", {
      model: "fixture/test",
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          name: "Fixture",
          options: { baseURL: new URL("/v1", input.model.url).href, apiKey: "fixture" },
          models: { test: { name: "Test", limit: { context: 8192, output: 512 } } },
        },
      },
    })
    expect(configure.status, await configure.text()).toBe(200)
    const worktree = await call("/experimental/worktree", input.project, "POST", { name: "backend-flow" })
    expect(worktree.status).toBe(200)
    const { directory } = (await worktree.json()) as { directory: string }
    input.target.file = path.join(directory, "written.txt")
    const create = await call("/session", directory, "POST", {
      title: "Backend flow",
      permission: [{ permission: "edit", pattern: "*", action: "ask" }],
    })
    expect(create.status).toBe(200)
    const session = (await create.json()) as { id: string }
    await input.cli(["run", "Write the fixture file.", "--session", session.id, "--dir", directory, "--no-wait"])
    const permission = await until("backend permission after submitting CLI exited", async () => {
      const response = await call("/permission", directory)
      expect(response.status).toBe(200)
      return ((await response.json()) as Array<{ id: string; sessionID: string }>).find(
        (item) => item.sessionID === session.id,
      )
    })
    expect(backend.exitCode).toBeNull()
    expect(await Bun.file(input.target.file).exists()).toBe(false)
    expect((await call(`/session/${session.id}`, directory, "DELETE")).status).toBe(409)
    await input.cli(["permission", "reply", permission.id, "once", "--session", session.id, "--dir", directory])
    await until("completed backend write", async () => {
      const response = await call("/session/status", directory)
      expect(response.status).toBe(200)
      const states = (await response.json()) as Record<string, { type: string }>
      if ((await Bun.file(input.target.file).exists()) && (states[session.id]?.type ?? "idle") === "idle") return true
    })
    expect(await Bun.file(input.target.file).text()).toBe("written by the backend")
    const exported = JSON.parse(await input.cli(["export", session.id, "--dir", directory])) as {
      messages: Array<{ parts: Array<{ text?: string }> }>
    }
    expect(
      exported.messages
        .flatMap((message) => message.parts)
        .some((part) => part.text === "Backend completed the write."),
    ).toBe(true)
    expect(input.requests).toHaveLength(2)
    expect((await call(`/session/${session.id}`, directory, "PATCH", { time: { archived: Date.now() } })).status).toBe(
      200,
    )
    expect(await Bun.file(input.target.file).exists()).toBe(false)
    expect(await realpath(directory).catch(() => undefined)).toBeUndefined()
    expect((await call(`/session/${session.id}`, directory, "PATCH", { time: { archived: null } })).status).toBe(200)
    expect(await Bun.file(input.target.file).text()).toBe("written by the backend")
    expect(backend.exitCode).toBeNull()
  } catch (error) {
    backend.kill("SIGKILL")
    await backend.exited
    throw new Error(`${error instanceof Error ? error.stack : String(error)}\n${(await logs).join("\n").slice(-8_000)}`)
  }
}, 120_000)
