import yargs from "yargs/yargs"
import type { Argv } from "yargs"
import path from "node:path"
import { stat } from "node:fs/promises"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { LabBackend } from "@opencode-ai/core/lab-backend"
import { StoragePaths } from "@opencode-ai/core/storage-paths"
import { LabEnvironment } from "@opencode-ai/core/lab-environment"
import { Identifier } from "@/id/id"

const request = { throwOnError: true } as const

/** Lab commands are clients of the profile owner; never fall back to an embedded server. */
export async function run(
  args: string[],
  connection: LabBackend.Connection | (() => Promise<LabBackend.Connection>),
  root: string,
): Promise<void> {
  const resolved = { connection: undefined as Promise<LabBackend.Connection> | undefined }
  const backend = () =>
    (resolved.connection ??= typeof connection === "function" ? connection() : Promise.resolve(connection))
  const client = async (directory = process.cwd()) => {
    const remote = await backend()
    return createOpencodeClient({
      baseUrl: remote.url,
      headers: authorization(remote),
      directory: path.resolve(directory),
    })
  }
  const sessionClient = async (sessionID?: string, directory?: string) => {
    const sdk = await client(directory)
    if (!sessionID) return sdk
    const session = (await sdk.session.get({ sessionID }, request)).data
    return client(session.directory)
  }
  const unsupported = new Set([
    "db",
    "serve",
    "web",
    "auth",
    "mcp",
    "agent",
    "generate",
    "stats",
    "import",
    "github",
    "console",
    "upgrade",
    "uninstall",
  ])
  if (args[0] && unsupported.has(args[0])) {
    throw new Error(
      `opencode-lab ${args[0]} is not available through the shared backend; no local fallback was started`,
    )
  }

  await yargs(args)
    .scriptName("opencode-lab")
    .exitProcess(false)
    .strict()
    .version(false)
    .help()
    .fail((message, error) => {
      throw error ?? new Error(message)
    })
    .option("dir", { type: "string", describe: "project directory on this Lab backend" })
    .command(
      "$0 [project]",
      "open the Lab terminal interface",
      (cli) =>
        resumeOptions(cli)
          .positional("project", { type: "string" })
          .option("model", { type: "string", alias: "m" })
          .option("agent", { type: "string" })
          .option("prompt", { type: "string" }),
      async (options) => {
        const directory = path.resolve(options.dir ?? options.project ?? process.cwd())
        if (!(await stat(directory).catch(() => undefined))?.isDirectory()) {
          throw new Error(`Project directory does not exist: ${directory}`)
        }
        if (options.fork && !options.session && !options.continue)
          throw new Error("--fork requires --session or --continue")
        if (options.session) await (await client(directory)).session.get({ sessionID: options.session }, request)
        const remote = await backend()
        process.chdir(directory)
        LabEnvironment.prepare(process.env, root)
        // Reuse Attach's UI components without its Session schema import or the
        // mini adapter, which loads the backend AppRuntime.
        const { TuiConfig } = await import("@/config/tui")
        const { createLegacyTuiPluginHost } = await import("@/plugin/tui/runtime")
        const { Effect } = await import("effect")
        const { run } = await import("@/cli/tui/layer")
        await Effect.runPromise(
          run({
            url: remote.url,
            headers: authorization(remote),
            directory,
            config: await TuiConfig.get({ migrate: false }),
            pluginHost: createLegacyTuiPluginHost({ configOptions: { migrate: false }, serverPlugins: false }),
            args: {
              sessionID: options.session,
              continue: options.continue,
              fork: options.fork,
              model: options.model,
              agent: options.agent,
              prompt: options.prompt,
            },
          }),
        )
      },
    )
    .command(
      "run [message..]",
      "send a prompt through the Lab backend",
      (cli) =>
        resumeOptions(cli)
          .positional("message", { type: "string", array: true })
          .option("model", { type: "string", alias: "m" })
          .option("agent", { type: "string" })
          .option("variant", { type: "string" })
          .option("title", { type: "string" })
          .option("format", { choices: ["default", "json"] as const, default: "default" as const })
          .option("wait", {
            type: "boolean",
            default: true,
            describe: "wait for completion; --no-wait prints the admitted session ID",
          }),
      async (options) => {
        if (options.fork && !options.session && !options.continue)
          throw new Error("--fork requires --session or --continue")
        const input = (options.message ?? []).join(" ")
        const piped = process.stdin.isTTY ? "" : await Bun.stdin.text()
        const text = [input, piped].filter(Boolean).join("\n")
        if (!text.trim()) throw new Error("A prompt is required")
        const model = options.model ? parseModel(options.model) : undefined
        const sdk = await client(options.dir)
        const previous = options.session
          ? (await sdk.session.get({ sessionID: options.session }, request)).data
          : options.continue
            ? (await sdk.session.list({ roots: true, limit: 1 }, request)).data[0]
            : undefined
        if (options.continue && !previous) throw new Error("No session is available to continue")
        const session = previous
          ? options.fork
            ? (await (await client(previous.directory)).session.fork({ sessionID: previous.id }, request)).data
            : previous
          : (await sdk.session.create({ title: options.title }, request)).data
        const remote = await client(session.directory)
        const messageID = Identifier.ascending("message")
        const payload = {
          sessionID: session.id,
          messageID,
          agent: options.agent,
          variant: options.variant,
          model,
          parts: [{ type: "text" as const, text }],
        }
        if (!options.wait) {
          await remote.session.promptAsync(payload, request)
          console.log(session.id)
          return
        }
        const controller = new AbortController()
        const ready = Promise.withResolvers<void>()
        const events = await remote.event.subscribe(undefined, { signal: controller.signal, sseMaxRetryAttempts: 1 })
        const output = consume(events.stream, session.id, messageID, options.format === "json", ready.resolve)
        // Observe errors immediately while admission is in flight; finally closes only
        // this client's event stream, never interrupts the backend's execution.
        void output.catch(() => {})
        try {
          await Promise.race([ready.promise, output])
          await remote.session.promptAsync(payload, request)
          console.error(`Session: ${session.id}`)
          await output
        } finally {
          controller.abort()
        }
      },
    )
    .command(
      "session",
      "manage sessions on the backend",
      (cli) =>
        cli
          .command(
            "list",
            "list sessions",
            (cli) =>
              cli
                .option("max-count", { type: "number", alias: "n" })
                .option("format", { choices: ["table", "json"] as const, default: "table" as const }),
            async (options) => {
              if (options.maxCount !== undefined && (!Number.isSafeInteger(options.maxCount) || options.maxCount < 1))
                throw new Error("--max-count must be a positive integer")
              const sessions = (
                await (await client(options.dir)).session.list({ roots: true, limit: options.maxCount }, request)
              ).data
              if (options.format === "json") return json(sessions)
              console.log(
                [
                  "Session ID\tTitle\tUpdated",
                  ...sessions.map(
                    (session) => `${session.id}\t${session.title}\t${new Date(session.time.updated).toISOString()}`,
                  ),
                ].join("\n"),
              )
            },
          )
          .command(
            "delete <sessionID>",
            "delete a session through its backend",
            (cli) => cli.positional("sessionID", { type: "string", demandOption: true }),
            async (options) => {
              const sdk = await client(options.dir)
              const session = (await sdk.session.get({ sessionID: options.sessionID }, request)).data
              await (await client(session.directory)).session.delete({ sessionID: session.id }, request)
              console.log(`Session ${session.id} deleted`)
            },
          )
          .demandCommand(1),
      () => {},
    )
    .command(
      "export <sessionID>",
      "export session history as JSON",
      (cli) => cli.positional("sessionID", { type: "string", demandOption: true }),
      async (options) => {
        const info = (await (await client(options.dir)).session.get({ sessionID: options.sessionID }, request)).data
        const messages = (await (await client(info.directory)).session.messages({ sessionID: info.id }, request)).data
        json({ info, messages })
      },
    )
    .command(
      "models [provider]",
      "list models reported by the backend",
      (cli) => cli.positional("provider", { type: "string" }).option("verbose", { type: "boolean" }),
      async (options) => {
        const providers = (await (await client(options.dir)).provider.list(undefined, request)).data
        const connected = providers.all.filter(
          (provider) =>
            providers.connected.includes(provider.id) && (!options.provider || provider.id === options.provider),
        )
        if (options.provider && !connected.length) throw new Error(`Provider is not connected: ${options.provider}`)
        for (const provider of connected.sort((a, b) => a.id.localeCompare(b.id))) {
          for (const [id, model] of Object.entries(provider.models).sort(([a], [b]) => a.localeCompare(b))) {
            console.log(`${provider.id}/${id}`)
            if (options.verbose) json(model)
          }
        }
      },
    )
    .command(
      "debug <target>",
      "inspect backend configuration or storage paths",
      (cli) => cli.positional("target", { choices: ["paths", "config"] as const, demandOption: true }),
      async (options) => {
        if (options.target === "paths") return json(StoragePaths.profile(root))
        json((await (await client(options.dir)).config.get(undefined, request)).data)
      },
    )
    .command(
      "permission",
      "inspect or explicitly answer a pending request",
      (cli) =>
        cli
          .option("session", {
            type: "string",
            alias: "s",
            describe: "resolve the pending request's session directory",
          })
          .command(
            "list",
            "list pending permission requests",
            (cli) => cli,
            async (options) => {
              json((await (await sessionClient(options.session, options.dir)).permission.list(undefined, request)).data)
            },
          )
          .command(
            "reply <requestID> <reply>",
            "submit an explicit permission answer",
            (cli) =>
              cli
                .positional("requestID", { type: "string", demandOption: true })
                .positional("reply", { choices: ["once", "always", "reject"] as const, demandOption: true }),
            async (options) => {
              await (
                await sessionClient(options.session, options.dir)
              ).permission.reply({ requestID: options.requestID, reply: options.reply }, request)
              console.log(`Permission ${options.requestID}: ${options.reply}`)
            },
          )
          .demandCommand(1),
      () => {},
    )
    .parseAsync()
}

function authorization(connection: LabBackend.Connection) {
  return { Authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}` }
}

function resumeOptions<T>(cli: Argv<T>) {
  return cli
    .option("session", { type: "string", alias: "s" })
    .option("continue", { type: "boolean", alias: "c" })
    .option("fork", { type: "boolean" })
}

function parseModel(value: string) {
  const split = value.indexOf("/")
  if (split < 1 || split === value.length - 1) throw new Error("--model must be provider/model")
  return { providerID: value.slice(0, split), modelID: value.slice(split + 1) }
}

function json(value: unknown) {
  console.log(JSON.stringify(value, null, 2))
}

async function consume(
  events: Awaited<ReturnType<ReturnType<typeof createOpencodeClient>["event"]["subscribe"]>>["stream"],
  sessionID: string,
  messageID: string,
  structured: boolean,
  ready: () => void,
) {
  const state = { visible: false }
  const printed = new Set<string>()
  const sessions = new Set([sessionID])
  for await (const event of events) {
    if (event.type === "server.connected") ready()
    if (
      event.type === "session.created" &&
      event.properties.info.parentID &&
      sessions.has(event.properties.info.parentID)
    )
      sessions.add(event.properties.info.id)
    if (
      !("sessionID" in event.properties) ||
      typeof event.properties.sessionID !== "string" ||
      !sessions.has(event.properties.sessionID)
    )
      continue
    if (structured) console.log(JSON.stringify(event))
    if (event.type === "permission.asked") {
      console.error(
        `Waiting for permission ${event.properties.id}. Answer in OpenCode Lab or run: opencode-lab permission reply ${event.properties.id} once|always|reject --session ${event.properties.sessionID}`,
      )
    }
    if (event.type === "question.asked") console.error("Waiting for your answer in OpenCode Lab")
    if (event.properties.sessionID !== sessionID) continue
    if (event.type === "message.updated" && event.properties.info.id === messageID) state.visible = true
    if (event.type === "session.error")
      throw new Error(JSON.stringify(event.properties.error ?? "Backend execution failed"))
    if (event.type === "message.part.updated" && state.visible && !structured) {
      const part = event.properties.part
      if (part.type === "text" && part.messageID !== messageID && part.time?.end && !printed.has(part.id)) {
        printed.add(part.id)
        console.log(part.text)
      }
    }
    if (state.visible && event.type === "session.status" && event.properties.status.type === "idle") return
  }
  throw new Error(`Backend event stream ended before completion; session ${sessionID} may still be running`)
}
