import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dispose) => dispose()))
})

async function fixture(mode: "complete" | "permission" | "failure" = "complete") {
  const base = await mkdtemp(path.join(os.tmpdir(), "lab-client-contract-"))
  const requests: Array<{ method: string; pathname: string; directory: string | null; body: Record<string, unknown> }> =
    []
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const pending = Promise.withResolvers<void>()
  const session = {
    id: "ses_contract",
    title: "Backend session",
    directory: path.join(base, "project"),
    time: { updated: 1 },
  }
  const prompt = { id: "" }
  const emit = (type: string, properties: Record<string, unknown>) => {
    for (const stream of streams)
      stream.enqueue(
        new TextEncoder().encode(`data: ${JSON.stringify({ id: crypto.randomUUID(), type, properties })}\n\n`),
      )
  }
  const complete = () => {
    emit("message.part.updated", {
      sessionID: session.id,
      part: {
        id: "prt_answer",
        sessionID: session.id,
        messageID: "msg_answer",
        type: "text",
        text: "Backend answer",
        time: { end: 1 },
      },
    })
    emit("session.status", { sessionID: session.id, status: { type: "idle" } })
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (
        request.headers.get("authorization") !== `Basic ${Buffer.from("opencode:contract-secret").toString("base64")}`
      )
        return new Response("Unauthorized", { status: 401 })
      const url = new URL(request.url)
      const text = request.method === "POST" ? await request.text() : ""
      const body: Record<string, unknown> = text ? JSON.parse(text) : {}
      requests.push({
        method: request.method,
        pathname: url.pathname,
        directory: url.searchParams.get("directory") ?? request.headers.get("x-opencode-directory"),
        body,
      })
      if (url.pathname === "/event") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streams.add(controller)
            controller.enqueue(
              new TextEncoder().encode('data: {"id":"evt_ready","type":"server.connected","properties":{}}\n\n'),
            )
          },
          cancel() {
            streams.clear()
          },
        })
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } })
      }
      if (url.pathname === "/session" && request.method === "GET") return Response.json([session])
      if (url.pathname === "/session" && request.method === "POST") return Response.json(session)
      if (url.pathname === "/session/ses_contract") return Response.json(request.method === "DELETE" ? true : session)
      if (url.pathname === "/session/ses_contract/fork") return Response.json(session)
      if (url.pathname === "/session/ses_contract/message")
        return Response.json([
          { info: { id: "msg_answer", role: "assistant" }, parts: [{ type: "text", text: "Saved answer" }] },
        ])
      if (url.pathname === "/session/ses_contract/prompt_async") {
        prompt.id = String(body.messageID)
        emit("message.updated", { sessionID: session.id, info: { id: prompt.id, role: "user", sessionID: session.id } })
        if (mode === "failure")
          emit("session.error", {
            sessionID: session.id,
            error: { name: "UnknownError", data: { message: "Backend refused execution" } },
          })
        if (mode === "complete") complete()
        if (mode === "permission") {
          emit("permission.asked", {
            sessionID: session.id,
            id: "per_contract",
            permission: "edit",
            patterns: ["file.txt"],
          })
          pending.resolve()
        }
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/permission") return Response.json([{ id: "per_contract", sessionID: session.id }])
      if (url.pathname === "/permission/per_contract/reply") {
        complete()
        return Response.json(true)
      }
      if (url.pathname === "/config") return Response.json({ model: "test/model" })
      if (url.pathname === "/provider")
        return Response.json({
          all: [{ id: "test", models: { model: { id: "model" } } }],
          connected: ["test"],
          default: { test: "model" },
        })
      return Response.json({ name: "NotFoundError", data: { message: "Session not found" } }, { status: 404 })
    },
  })
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("OPENCODE_") &&
        !key.startsWith("XDG_") &&
        !key.startsWith("CODEX_") &&
        !["NODE_OPTIONS", "BUN_OPTIONS"].includes(key),
    ),
  )
  for (const [key, name] of Object.entries({
    HOME: "home",
    OPENCODE_TEST_HOME: "home",
    XDG_DATA_HOME: "xdg-data",
    XDG_CONFIG_HOME: "xdg-config",
    XDG_CACHE_HOME: "xdg-cache",
    XDG_STATE_HOME: "xdg-state",
    TMPDIR: "tmp",
  })) {
    env[key] = path.join(base, name)
    await mkdir(env[key]!, { recursive: true })
  }
  await mkdir(session.directory)
  const root = path.join(base, "profile")
  const processes: ReturnType<typeof Bun.spawn>[] = []
  const spawn = (args: string[], allowConnection = true, source?: string) => {
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        source
          ? source + "\nprocess.exit()"
          : `
      const { run } = await import('./src/lab/cli.ts')
      try {
        await run(JSON.parse(process.env.LAB_ARGS), async () => {
          if (process.env.LAB_CONNECT !== '1') throw new Error('Backend startup was forbidden')
          return JSON.parse(process.env.LAB_CONNECTION)
        }, process.env.OPENCODE_HOME)
      } catch (error) { console.error(error instanceof Error ? error.message : JSON.stringify(error)); process.exitCode = 1 }
    `,
      ],
      {
        cwd: path.join(import.meta.dir, "../.."),
        env: {
          ...env,
          OPENCODE_HOME: root,
          OPENCODE_DB: path.join(root, "must-not-open.db"),
          LAB_ARGS: JSON.stringify(args),
          LAB_CONNECT: allowConnection ? "1" : "0",
          LAB_CONNECTION: JSON.stringify({
            pid: process.pid,
            protocol: 1,
            url: server.url.toString(),
            username: "opencode",
            password: "contract-secret",
          }),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    processes.push(proc)
    return proc
  }
  const result = async (proc: ReturnType<typeof spawn>) => {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    return { code, stdout, stderr }
  }
  cleanup.push(async () => {
    for (const proc of processes) if (proc.exitCode === null) proc.kill()
    await Promise.all(processes.map((proc) => proc.exited))
    await server.stop(true)
    await rm(base, { recursive: true, force: true })
  })
  return { root, session, requests, spawn, result, pending: pending.promise }
}

test("help, pure paths and unsupported local commands never resolve a backend or create a profile", async () => {
  const test = await fixture()
  for (const args of [["--help"], ["run", "--help"], ["debug", "paths"]]) {
    const result = await test.result(test.spawn(args, false))
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain(args[0] === "debug" ? path.join(test.root, "worktrees") : "session")
  }
  for (const args of [["db"], ["run", "hello", "--auto"], ["--mini"], ["models", "--refresh"]]) {
    const result = await test.result(test.spawn(args, false))
    expect(result.code).toBe(1)
    expect(result.stderr).not.toContain("Backend startup was forbidden")
  }
  expect(test.requests).toEqual([])
  expect(await readdir(test.root).catch(() => [])).toEqual([])
})

test("session, export, models and config commands use authenticated HTTP and backend session placement", async () => {
  const test = await fixture()
  const list = await test.result(test.spawn(["session", "list", "--format", "json", "-n", "2"]))
  expect(list.code, list.stderr).toBe(0)
  expect(JSON.parse(list.stdout)[0].id).toBe(test.session.id)
  expect(test.requests[0]?.directory).toBe(path.join(import.meta.dir, "../.."))
  const exported = await test.result(test.spawn(["export", test.session.id]))
  expect(exported.code, exported.stderr).toBe(0)
  expect(JSON.parse(exported.stdout).messages[0].parts[0].text).toBe("Saved answer")
  const models = await test.result(test.spawn(["models"]))
  expect(models.code, models.stderr).toBe(0)
  expect(models.stdout.trim()).toBe("test/model")
  const config = await test.result(test.spawn(["debug", "config"]))
  expect(config.code, config.stderr).toBe(0)
  expect(JSON.parse(config.stdout)).toEqual({ model: "test/model" })
  const deleted = await test.result(test.spawn(["session", "delete", test.session.id]))
  expect(deleted.code, deleted.stderr).toBe(0)
  expect(test.requests.find((request) => request.method === "DELETE")?.directory).toBe(
    encodeURIComponent(test.session.directory),
  )
  expect(await readdir(test.root).catch(() => [])).toEqual([])
})

test("run subscribes before submitting exactly one prompt and prints the backend answer", async () => {
  const test = await fixture()
  const result = await test.result(
    test.spawn(["run", "hello", "world", "--model", "test/model", "--agent", "build", "--variant", "high"]),
  )
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe("Backend answer")
  const submitted = test.requests.filter((request) => request.pathname.endsWith("/prompt_async"))
  expect(submitted).toHaveLength(1)
  expect(submitted[0]?.body).toMatchObject({
    agent: "build",
    variant: "high",
    model: { providerID: "test", modelID: "model" },
    parts: [{ type: "text", text: "hello world" }],
  })
  expect(test.requests.findIndex((request) => request.pathname === "/event")).toBeLessThan(
    test.requests.findIndex((request) => request.pathname.endsWith("/prompt_async")),
  )
  expect(test.requests.some((request) => request.pathname.endsWith("/abort"))).toBe(false)
  expect(await readdir(test.root).catch(() => [])).toEqual([])
})

test("continue and fork follow backend placement and no-wait does not subscribe or stop execution", async () => {
  const test = await fixture()
  const result = await test.result(test.spawn(["run", "follow up", "--continue", "--fork", "--no-wait"]))
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe(test.session.id)
  expect(test.requests.map((request) => request.pathname)).toEqual([
    "/session",
    "/session/ses_contract/fork",
    "/session/ses_contract/prompt_async",
  ])
  expect(test.requests.slice(1).map((request) => request.directory)).toEqual([
    encodeURIComponent(test.session.directory),
    encodeURIComponent(test.session.directory),
  ])
})

test("pending permissions remain pending until a separate explicit reply command", async () => {
  const test = await fixture("permission")
  const running = test.spawn(["run", "edit the file"])
  const completed = test.result(running)
  await test.pending
  expect(test.requests.some((request) => request.pathname.endsWith("/reply"))).toBe(false)
  const pending = await test.result(test.spawn(["permission", "list"]))
  expect(pending.code, pending.stderr).toBe(0)
  expect(JSON.parse(pending.stdout)[0].id).toBe("per_contract")
  const replied = await test.result(test.spawn(["permission", "reply", "per_contract", "once"]))
  expect(replied.code, replied.stderr).toBe(0)
  const result = await completed
  expect(result.code, result.stderr).toBe(0)
  expect(result.stderr).toContain("Waiting for permission per_contract")
  expect(test.requests.filter((request) => request.pathname.endsWith("/reply")).map((request) => request.body)).toEqual(
    [{ reply: "once" }],
  )
})

test("backend errors fail the command without retrying execution", async () => {
  const test = await fixture("failure")
  const result = await test.result(test.spawn(["run", "hello"]))
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("Backend refused execution")
  expect(test.requests.filter((request) => request.pathname.endsWith("/prompt_async"))).toHaveLength(1)
})

test("the default TUI validates a resumed session remotely before loading local UI state", async () => {
  const test = await fixture()
  const result = await test.result(test.spawn(["--session", "ses_missing"]))
  expect(result.code).toBe(1)
  expect(test.requests.map((request) => request.pathname)).toEqual(["/session/ses_missing"])
  expect(await readdir(test.root).catch(() => [])).toEqual([])
})

test("the reused TUI components load in a version 2 client without opening the backend database", async () => {
  const test = await fixture()
  await Bun.write(
    path.join(test.root, "storage.json"),
    JSON.stringify({ version: 2, backendProtocol: 1, source: null, status: "complete", database: "opencode.db" }),
  )
  const original = '{"model":"test/model","theme":"gruvbox","tui":{"scroll_speed":9}}\n'
  await Bun.write(path.join(test.root, "config", "opencode.json"), original)
  const result = await test.result(
    test.spawn(
      [],
      false,
      `
    const { LabEnvironment } = await import('@opencode-ai/core/lab-environment')
    LabEnvironment.prepare(process.env, process.env.OPENCODE_HOME)
    const { TuiConfig } = await import('./src/config/tui.ts')
    const { createLegacyTuiPluginHost } = await import('./src/plugin/tui/runtime.ts')
    const { run } = await import('./src/cli/tui/layer.ts')
    await TuiConfig.get({ migrate: false })
    await TuiConfig.pluginOrigins({ migrate: false })
    await TuiConfig.waitForDependencies({ migrate: false })
    await createLegacyTuiPluginHost({ configOptions: { migrate: false }, serverPlugins: false }).dispose()
    console.log(typeof run)
  `,
    ),
  )
  expect(result.code, result.stderr).toBe(0)
  expect(result.stdout.trim()).toBe("function")
  expect((await readdir(path.join(test.root, "data"))).filter((name) => name.endsWith(".db"))).toEqual([])
  expect(await Bun.file(path.join(test.root, "config", "opencode.json")).text()).toBe(original)
  expect(await Bun.file(path.join(test.root, "config", "opencode.json.tui-migration.bak")).exists()).toBe(false)
  expect(await Bun.file(path.join(test.root, "config", "tui.json")).exists()).toBe(false)
})

test("read-only TUI loading does not change the default loader's migration behavior", async () => {
  const test = await fixture()
  await Bun.write(path.join(test.root, "config", "opencode.json"), '{"theme":"gruvbox","model":"test/model"}')
  const result = await test.result(
    test.spawn(
      [],
      false,
      `
    const { LabEnvironment } = await import('@opencode-ai/core/lab-environment')
    LabEnvironment.prepare(process.env, process.env.OPENCODE_HOME)
    const { TuiConfig } = await import('./src/config/tui.ts')
    const before = await TuiConfig.get({ migrate: false })
    const after = await TuiConfig.get()
    console.log(JSON.stringify({ before: before.theme, after: after.theme }))
  `,
    ),
  )
  expect(result.code, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ after: "gruvbox" })
  expect(await Bun.file(path.join(test.root, "config", "tui.json")).exists()).toBe(true)
})
