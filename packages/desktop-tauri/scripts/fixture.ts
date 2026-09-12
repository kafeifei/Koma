import { mkdir, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { assertTestPath, profile as defaultProfile, testRoot } from "./paths"
import { StorageMigration } from "../../core/src/storage-migration"

// A deterministic local provider exercises the real Session -> SSE -> UI path.
// It is deliberately labelled as a fixture and never contacts a real model.
const profile = process.env.KOMA_FIXTURE_HOME ? assertTestPath(process.env.KOMA_FIXTURE_HOME) : defaultProfile
await mkdir(profile, { recursive: true, mode: 0o700 })
assertTestPath(await realpath(profile))
// Initialize an empty profile through the same storage contract as the backend,
// before adding fixture configuration; pre-seeding config would look like an
// unrelated existing profile to the migration guard.
const lease = await StorageMigration.lock(profile)
try {
  StorageMigration.prepareUnifiedHome({ root: profile, legacyRoot: `${profile}.legacy`, acquireLock: () => true })
} finally {
  await lease.release()
}
const responseText =
  "TAURI_STREAM_OK\n\n这是本地固定响应，用于验证 Tauri 的聊天流式显示、中文文本和历史保存；这不是实际模型回答。"
let requests = 0
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST" || !new URL(request.url).pathname.endsWith("/chat/completions"))
      return new Response("Local Tauri test fixture", { status: 404 })
    const body = (await request.json()) as { stream?: boolean }
    requests++
    const common = { id: `tauri-fixture-${requests}`, created: Math.floor(Date.now() / 1000), model: "stream-test" }
    if (!body.stream)
      return Response.json({
        ...common,
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: responseText }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream({
        async start(controller) {
          const emit = (delta: object, finish_reason: string | null = null) =>
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
              ),
            )
          try {
            emit({ role: "assistant", content: "" })
            for (const content of responseText.match(/.{1,6}|\n/gu) ?? []) {
              emit({ content })
              await Bun.sleep(80)
            }
            emit({}, "stop")
            controller.enqueue(encoder.encode("data: [DONE]\n\n"))
            controller.close()
          } catch {
            /* A user can interrupt the test turn. */
          }
        },
      }),
      { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } },
    )
  },
})

const configDir = join(profile, "config")
await mkdir(configDir, { recursive: true, mode: 0o700 })
const configFile = Bun.file(join(configDir, "opencode.json"))
const config = (await configFile.exists()) ? await configFile.json() : {}
config.provider ??= {}
config.provider["tauri-fixture"] = {
  name: "本地链路测试（非真实模型）",
  npm: "@ai-sdk/openai-compatible",
  options: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "local-test-only" },
  models: { "stream-test": { name: "本地流式测试", limit: { context: 200000, output: 2048 } } },
}
config.model ??= "tauri-fixture/stream-test"
config.small_model ??= "tauri-fixture/stream-test"
await writeFile(configFile.name!, JSON.stringify(config, null, 2), { mode: 0o600 })
const project = join(testRoot, "projects", "hello-tauri")
await mkdir(project, { recursive: true })
await writeFile(
  join(project, "README.md"),
  "# Tauri test project\n\nDisposable workspace for chat and terminal validation.\n",
)
if (!existsSync(join(project, ".git"))) {
  const git = (args: string[]) => execFileSync("git", args, { cwd: project, stdio: "pipe" })
  git(["init", "--initial-branch=main"])
  git(["add", "README.md"])
  // This commit belongs only to the disposable fixture repository. Without a
  // repository boundary Git would discover the enclosing source worktree.
  git([
    "-c",
    "user.name=Tauri Test",
    "-c",
    "user.email=tauri-test@localhost",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Initialize disposable Tauri fixture",
  ])
}
await mkdir(join(testRoot, "results"), { recursive: true })
await writeFile(
  join(testRoot, "results", "fixture.json"),
  JSON.stringify({ pid: process.pid, url: server.url.origin, project, profile }, null, 2),
)
console.log(
  `Local fixture listening on ${server.url.origin}\nTest project: ${project}\nOnly the Tauri test profile was configured. Stop this fixture with Ctrl+C.`,
)
