import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { createStore } from "solid-js/store"
import type { ImageAttachmentPart, Prompt, PromptStore } from "@/context/prompt"
import type { ModelSelection } from "@/context/local"
import type { ExternalPromptRequest } from "@/context/prompt"

let createPromptSubmit: typeof import("./submit").createPromptSubmit

const createdClients: string[] = []
const createdSessions: string[] = []
const worktreeCreateInputs: unknown[] = []
let promptSent: (() => void) | undefined
const sessionCreateInputs: Array<{
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  permissionMode?: "default" | "auto" | "full"
  location?: { directory: string }
}> = []
const optimistic: Array<{
  directory?: string
  sessionID?: string
  message: {
    agent: string
    model: { providerID: string; modelID: string }
    variant?: string
  }
}> = []
const optimisticSeeded: boolean[] = []
const storedSessions: Record<string, Array<{ id: string; title?: string }>> = {}
const promoted: Array<{ directory: string; sessionID: string }> = []
const sentShell: Array<{ sessionID: string; id?: string; command: string }> = []
const syncedDirectories: string[] = []
const promotedDrafts: Array<{ draftID: string; server: string; sessionId: string }> = []
const sentPrompts: string[] = []
const promptInputs: unknown[] = []
const sentCommands: unknown[] = []
const commands: Array<{ name: string }> = []
let serverSessionSyncs = 0
const externalCreates: unknown[] = []
const externalSubmits: unknown[] = []
const externalInterrupts: string[] = []
const externalDeliveryChecks: unknown[] = []
let externalEngine: "opencode" | "codex" = "opencode"
let externalDeliveryState: "pending" | "sending" | "accepted" | "unknown" | "rejected" | "withdrawn" = "accepted"
let externalRequest: ExternalPromptRequest | undefined
let resetCount = 0
let codexSettings: { model?: string; effort?: string; permission?: "workspace" | "readOnly" | "full" } = {}
let codexRevision = 0
let codexPendingSettings: typeof codexSettings | undefined
let todoClears = 0
let externalRuntimeStatus = "idle"
let externalPromptCapability = true
let externalCreateGate: Promise<void> | undefined
let externalCreateError = false
let externalCheckedState: "pending" | "sending" | "accepted" | "unknown" | "rejected" | "withdrawn" = "unknown"
let externalSubmitGate: Promise<void> | undefined
let imageEncodeGate: Promise<void> | undefined

let params: { id?: string } = {}
let search: { draftId?: string } = {}
let selected = "/repo/worktree-a"
let variant: string | undefined
let permissionMode: "default" | "auto" | "full" = "default"
let echoPermissionMode = true
let createSessionGate: Promise<void> | undefined
let createWorktreeGate: Promise<void> | undefined

let promptValue: Prompt = [{ type: "text", content: "ls", start: 0, end: 2 }]
const [promptStore, setPromptStore] = createStore<PromptStore>({
  prompt: promptValue,
  cursor: 0,
  context: { items: [] },
})
const prompt = {
  store: [() => promptStore, setPromptStore] as [() => PromptStore, typeof setPromptStore],
  ready: Object.assign(() => true, { promise: Promise.resolve(true) }),
  current: () => promptValue,
  cursor: () => 0,
  dirty: () => true,
  model: {
    current: () => undefined,
    set: () => undefined,
  },
  engine: {
    current: () => externalEngine,
    set: (value: "opencode" | "codex") => {
      externalEngine = value
    },
  },
  codex: {
    current: () => codexSettings,
    revision: () => codexRevision,
    set: (value: typeof codexSettings, options?: { explicit?: boolean; revision?: number }) => {
      codexSettings = value
      if (options?.revision !== undefined) codexRevision = options.revision
      if (options?.revision === undefined && options?.explicit !== false) codexRevision++
    },
  },
  externalRequest: {
    current: () => externalRequest,
    set: (value: ExternalPromptRequest | undefined) => {
      externalRequest = value
    },
  },
  reset: () => {
    resetCount++
  },
  set: (value: Prompt) => {
    promptValue = value
  },
  context: {
    add: () => undefined,
    remove: () => undefined,
    removeComment: () => undefined,
    updateComment: () => undefined,
    replaceComments: () => undefined,
    items: () => [],
  },
  capture: () => alternatePrompt ?? prompt,
}
let alternatePrompt: typeof prompt | undefined

const clientFor = (directory: string) => {
  createdClients.push(directory)
  return {
    api: {
      session: {
        create: async (input: (typeof sessionCreateInputs)[number]) => {
          await createSessionGate
          const location = input.location?.directory ?? directory
          createdSessions.push(location)
          sessionCreateInputs.push(input)
          return {
            id: `session-${createdSessions.length}`,
            projectID: "project",
            agent: input.agent,
            model: input.model,
            permissionMode: echoPermissionMode ? input.permissionMode : undefined,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
            title: `New session ${createdSessions.length}`,
            location: { directory: location },
          }
        },
        prompt: async (input: unknown) => {
          sentPrompts.push(directory)
          promptInputs.push(input)
          promptSent?.()
          return { data: undefined }
        },
        command: async (input: unknown) => {
          sentCommands.push(input)
        },
        shell: async (input: { sessionID: string; id?: string; command: string }) => {
          sentShell.push(input)
        },
      },
    },
    session: {
      command: async () => ({ data: undefined }),
      abort: async () => ({ data: undefined }),
    },
    worktree: {
      create: async (input: unknown) => {
        worktreeCreateInputs.push(input)
        await createWorktreeGate
        return { data: { directory: `${directory}/new` } }
      },
    },
  }
}

beforeAll(async () => {
  const rootClient = clientFor("/repo/main")

  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => params,
    useLocation: () => ({}),
    useSearchParams: () => [search, () => undefined],
  }))

  mock.module("@opencode-ai/sdk/v2/client", () => ({
    createOpencodeClient: (input: { directory: string }) => {
      createdClients.push(input.directory)
      return clientFor(input.directory)
    },
  }))

  mock.module("@opencode-ai/ui/toast", () => ({
    Toast: { Region: () => null },
    toaster: { dismiss: () => undefined },
    showToast: () => 0,
  }))

  mock.module("@opencode-ai/core/util/encode", () => ({
    base64Encode: (value: string) => value,
    checksum: (value: string) => value,
  }))

  mock.module("@/utils/draft-store", () => ({
    blobDataUrl: async () => {
      await imageEncodeGate
      return "data:image/png;base64,image"
    },
  }))

  mock.module("@/context/local", () => ({
    useLocal: () => ({
      model: {
        current: () => ({ id: "model", provider: { id: "provider" } }),
        variant: { current: () => variant },
      },
      agent: {
        current: () => ({ name: "agent" }),
      },
      session: {
        promote(directory: string, sessionID: string) {
          promoted.push({ directory, sessionID })
        },
      },
    }),
  }))

  mock.module("@/context/server", () => ({
    useServer: () => ({ key: "server-key" }),
  }))

  mock.module("@/context/tabs", () => ({
    useTabs: () => ({
      state: () => prompt,
      draft: () => ({ server: "project-server" }),
      promoteDraft: (draftID: string, session: { server: string; sessionId: string }) => {
        promotedDrafts.push({ draftID, ...session })
      },
    }),
  }))

  mock.module("@/context/prompt", () => ({
    usePrompt: () => prompt,
  }))

  mock.module("@/context/layout", () => ({
    useLayout: () => ({
      handoff: {
        setTabs: () => undefined,
      },
    }),
  }))

  mock.module("@/context/sdk", () => ({
    useSDK: () => {
      const sdk = {
        scope: "local",
        directory: "/repo/main",
        client: rootClient,
        api: rootClient.api,
        url: "http://localhost:4096",
        createClient(opts: any) {
          return clientFor(opts.directory)
        },
      }
      return () => sdk
    },
  }))

  mock.module("@/context/sync", () => ({
    useSync: () => () => ({
      data: { command: commands },
      session: {
        optimistic: {
          add: (value: {
            directory?: string
            sessionID?: string
            message: { agent: string; model: { providerID: string; modelID: string; variant?: string } }
          }) => {
            optimistic.push(value)
            optimisticSeeded.push(
              !!value.directory &&
                !!value.sessionID &&
                !!storedSessions[value.directory]?.find((item) => item.id === value.sessionID)?.title,
            )
          },
          remove: () => undefined,
        },
      },
      set: () => undefined,
    }),
  }))

  mock.module("@/context/server-sync", () => ({
    useServerSync: () => () => ({
      external: {
        data: {
          engines: [
            {
              id: "codex",
              available: true,
              capabilities: { prompt: true },
              models: [],
              account: { authenticated: true, requiresAuth: false },
            },
          ],
          get descriptors() {
            return externalEngine === "codex"
              ? {
                  "session-1": {
                    settings: codexSettings,
                    pendingSettings: codexPendingSettings,
                    runtimeStatus: externalRuntimeStatus,
                    capabilities: { prompt: externalPromptCapability },
                  },
                  "native-session": {
                    settings: codexSettings,
                    pendingSettings: codexPendingSettings,
                    runtimeStatus: externalRuntimeStatus,
                    capabilities: { prompt: externalPromptCapability },
                  },
                }
              : {}
          },
        },
        engine: () => externalEngine,
        describe: async () => [],
        refreshEngines: async () => [],
        actions: {
          create: async (value: { requestID: string }) => {
            externalCreates.push(value)
            await externalCreateGate
            if (externalCreateError) throw new Error("native create failed")
            return externalReceipt(value.requestID)
          },
          submit: async (value: { requestID: string }) => {
            externalSubmits.push(value)
            await externalSubmitGate
            return externalReceipt(value.requestID)
          },
          interrupt: async (sessionID: string) => {
            externalInterrupts.push(sessionID)
          },
          delivery: async (value: unknown) => {
            externalDeliveryChecks.push(value)
            return {
              sessionID: "native-session",
              requestID: (value as { requestID: string }).requestID,
              state: externalCheckedState,
              delivery: "queue",
              input: { prompt: { text: "ls", files: [] }, settings: codexSettings },
              createdAt: 1,
            }
          },
        },
      },
      session: {
        remember: () => undefined,
        set: (key: string) => {
          if (key === "todo") todoClears++
        },
        resolve: async (sessionID: string) => ({
          id: sessionID,
          projectID: "project",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
          title: "Native session",
          directory: "/repo/main",
        }),
        sync: async () => {
          serverSessionSyncs++
        },
      },
      child: (directory: string) => {
        syncedDirectories.push(directory)
        storedSessions[directory] ??= []
        return [
          { session: storedSessions[directory] },
          (...args: unknown[]) => {
            if (args[0] !== "session") return
            const next = args[1]
            if (typeof next === "function") {
              storedSessions[directory] = next(storedSessions[directory]) as Array<{ id: string; title?: string }>
              return
            }
            if (Array.isArray(next)) {
              storedSessions[directory] = next as Array<{ id: string; title?: string }>
            }
          },
        ]
      },
    }),
  }))

  mock.module("@/context/platform", () => ({
    usePlatform: () => ({
      fetch: fetch,
    }),
  }))

  mock.module("@/context/language", () => ({
    useLanguage: () => ({
      t: (key: string) => key,
    }),
  }))

  const mod = await import("./submit")
  createPromptSubmit = mod.createPromptSubmit
})

beforeEach(() => {
  createdClients.length = 0
  createdSessions.length = 0
  worktreeCreateInputs.length = 0
  promptSent = undefined
  sessionCreateInputs.length = 0
  optimistic.length = 0
  optimisticSeeded.length = 0
  promoted.length = 0
  promotedDrafts.length = 0
  sentPrompts.length = 0
  promptInputs.length = 0
  sentCommands.length = 0
  commands.length = 0
  promptValue = [{ type: "text", content: "ls", start: 0, end: 2 }]
  params = {}
  search = {}
  sentShell.length = 0
  syncedDirectories.length = 0
  selected = "/repo/worktree-a"
  variant = undefined
  permissionMode = "default"
  echoPermissionMode = true
  createSessionGate = undefined
  createWorktreeGate = undefined
  serverSessionSyncs = 0
  externalCreates.length = 0
  externalSubmits.length = 0
  externalInterrupts.length = 0
  externalDeliveryChecks.length = 0
  externalEngine = "opencode"
  externalDeliveryState = "accepted"
  externalRequest = undefined
  resetCount = 0
  codexSettings = {}
  codexRevision = 0
  codexPendingSettings = undefined
  todoClears = 0
  externalRuntimeStatus = "idle"
  externalPromptCapability = true
  externalCreateGate = undefined
  externalCreateError = false
  externalCheckedState = "unknown"
  externalSubmitGate = undefined
  imageEncodeGate = undefined
  alternatePrompt = undefined
  for (const key of Object.keys(storedSessions)) delete storedSessions[key]
})

function externalReceipt(requestID: string) {
  return {
    descriptor: {
      sessionID: "native-session",
      engine: "codex" as const,
      settings: codexSettings,
    },
    delivery: {
      requestID,
      state: externalDeliveryState,
      error: externalDeliveryState === "rejected" ? "rejected" : undefined,
    },
  }
}

describe("prompt submit worktree selection", () => {
  test("a pending worktree keeps the source identity until its real destination is created", async () => {
    const gate = Promise.withResolvers<void>()
    createWorktreeGate = gate.promise
    selected = "create"
    search.draftId = "input-source"
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      permissionMode: () => "full",
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => {},
      promptLength: () => 2,
      addToHistory: () => {},
      resetHistoryNavigation: () => {},
      setMode: () => {},
      setPopover: () => {},
      newSessionWorktree: () => selected,
    })
    const result = submit.handleSubmit({ preventDefault() {} } as Event)
    expect(createdSessions).toHaveLength(0)
    search.draftId = "input-other"
    selected = "/other"
    gate.resolve()
    await result
    expect(createdSessions).toEqual(["/repo/main/new"])
    expect(promotedDrafts).toEqual([{ draftID: "input-source", server: "project-server", sessionId: "session-1" }])
    expect(sessionCreateInputs[0]).toMatchObject({ permissionMode: "full", location: { directory: "/repo/main/new" } })
    expect(sentShell[0]).toMatchObject({ sessionID: "session-1", command: "ls" })
  })

  test("preserves an unready draft and sends its first prompt after synchronous worktree readiness without an event", async () => {
    const state = { ready: false }
    const sent = Promise.withResolvers<void>()
    promptSent = sent.resolve
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      permissionMode: () => "default",
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: () => 2,
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => "create",
      newSessionBaseBranch: () => "dev",
      newSessionWorktreeReady: () => state.ready,
      onSubmit: () => undefined,
    })
    await submit.handleSubmit(new Event("submit"))
    expect(createdSessions).toEqual([])
    expect(worktreeCreateInputs).toEqual([])
    expect(promptValue).toEqual([{ type: "text", content: "ls", start: 0, end: 2 }])
    state.ready = true
    const gate = Promise.withResolvers<void>()
    createWorktreeGate = gate.promise
    const pending = submit.handleSubmit(new Event("submit"))
    await submit.handleSubmit(new Event("submit"))
    expect(worktreeCreateInputs).toHaveLength(1)
    expect(createdSessions).toEqual([])
    gate.resolve()
    await pending
    await sent.promise
    expect(worktreeCreateInputs).toEqual([
      { directory: "/repo/main", worktreeCreateInput: { baseBranch: "dev", wait: true } },
    ])
    expect(createdSessions).toEqual(["/repo/main/new"])
    expect(promptInputs).toHaveLength(1)
  })

  test("reads the latest worktree accessor value per submit", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      permissionMode: () => "default",
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    selected = "/repo/worktree-b"
    await submit.handleSubmit(event)

    expect(createdClients).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(createdSessions).toEqual(["/repo/worktree-a", "/repo/worktree-b"])
    expect(sessionCreateInputs).toEqual([
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        permissionMode: "default",
        location: { directory: "/repo/worktree-a" },
      },
      {
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: undefined },
        permissionMode: "default",
        location: { directory: "/repo/worktree-b" },
      },
    ])
    expect(sentShell).toEqual([
      expect.objectContaining({ sessionID: "session-1", id: expect.stringMatching(/^evt_/), command: "ls" }),
      expect.objectContaining({ sessionID: "session-2", id: expect.stringMatching(/^evt_/), command: "ls" }),
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
    expect(serverSessionSyncs).toBe(0)
    expect(promoted).toEqual([
      { directory: "/repo/worktree-a", sessionID: "session-1" },
      { directory: "/repo/worktree-b", sessionID: "session-2" },
    ])
    expect(syncedDirectories).toEqual(["/repo/worktree-a", "/repo/worktree-a", "/repo/worktree-b", "/repo/worktree-b"])
  })

  test("includes the permission mode in session creation", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      permissionMode: () => "auto",
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(sessionCreateInputs[0]).toMatchObject({ permissionMode: "auto" })
  })

  test("does not send the prompt when the server ignores a non-default mode", async () => {
    echoPermissionMode = false
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      permissionMode: () => "full",
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sentShell).toEqual([])
    expect(promoted).toEqual([])
  })

  test("captures the permission mode before asynchronous session creation", async () => {
    search.draftId = "input-source"
    let release = () => {}
    createSessionGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      permissionMode: () => permissionMode,
      mode: () => "shell",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const result = submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)
    permissionMode = "full"
    search.draftId = "input-destination"
    selected = "/repo/worktree-b"
    release()
    await result

    expect(sessionCreateInputs[0]).toMatchObject({ permissionMode: "default" })
    expect(createdSessions).toEqual(["/repo/worktree-a"])
    expect(promotedDrafts[0]).toMatchObject({ draftID: "input-source" })
  })

  test("promotes drafts using the selected project's server", async () => {
    search = { draftId: "draft-1" }
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      permissionMode: () => "default",
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(promotedDrafts).toEqual([{ draftID: "draft-1", server: "project-server", sessionId: "session-1" }])
  })

  test("includes the selected variant on optimistic prompts", async () => {
    params = { id: "session-1" }
    variant = "high"

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      permissionMode: () => "default",
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)
    await Bun.sleep(0)

    expect(optimistic).toHaveLength(1)
    expect(optimistic[0]).toMatchObject({
      message: {
        agent: "agent",
        model: { providerID: "provider", modelID: "model", variant: "high" },
      },
    })
    expect(sentPrompts).toEqual(["/repo/main"])
    expect(promptInputs[0]).toMatchObject({
      sessionID: "session-1",
      text: "ls",
      files: [],
      agents: [],
    })
    expect((promptInputs[0] as { id?: string }).id).toStartWith("msg_")
    expect((promptInputs[0] as { legacyParts?: { id: string; type: string; text?: string }[] }).legacyParts).toEqual([
      { id: expect.stringMatching(/^prt_/), type: "text", text: "ls" },
    ])
  })

  test("submits slash commands through the current session API", async () => {
    params = { id: "session-1" }
    variant = "high"
    commands.push({ name: "review" })
    promptValue = [{ type: "text", content: "/review staged changes", start: 0, end: 22 }]

    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      permissionMode: () => "default",
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(sentCommands).toEqual([
      {
        sessionID: "session-1",
        id: expect.stringMatching(/^msg_/),
        command: "review",
        arguments: "staged changes",
        agent: "agent",
        model: { id: "model", providerID: "provider", variant: "high" },
        files: [],
      },
    ])
    expect(serverSessionSyncs).toBe(0)
  })

  test("uses an injected model selection", async () => {
    params = { id: "session-1" }
    const model = {
      current: () => ({ id: "draft-model", provider: { id: "draft-provider" } }),
      variant: { current: () => "draft-variant" },
    } as unknown as ModelSelection
    const submit = createPromptSubmit({
      prompt,
      info: () => ({ id: "session-1" }),
      imageAttachments: () => [],
      commentCount: () => 0,
      permissionMode: () => "default",
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      model,
    })

    await submit.handleSubmit({ preventDefault: () => undefined } as unknown as Event)

    expect(optimistic[0]).toMatchObject({
      message: {
        model: { providerID: "draft-provider", modelID: "draft-model", variant: "draft-variant" },
      },
    })
  })

  test("seeds new sessions before optimistic prompts are added", async () => {
    const submit = createPromptSubmit({
      prompt,
      info: () => undefined,
      imageAttachments: () => [],
      commentCount: () => 0,
      permissionMode: () => "default",
      mode: () => "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      newSessionWorktree: () => selected,
      onNewSessionWorktreeReset: () => undefined,
      onSubmit: () => undefined,
    })

    const event = { preventDefault: () => undefined } as unknown as Event

    await submit.handleSubmit(event)

    expect(storedSessions["/repo/worktree-a"]).toHaveLength(1)
    expect(storedSessions["/repo/worktree-a"]?.[0]).toMatchObject({ id: "session-1", title: "New session 1" })
    expect(optimisticSeeded).toEqual([true])
  })
})

describe("Codex prompt submission", () => {
  const create = (overrides?: {
    mode?: "normal" | "shell"
    imageAttachments?: () => ImageAttachmentPart[]
    shouldQueue?: () => boolean
    onQueue?: () => void
    onAbort?: () => void
  }) =>
    createPromptSubmit({
      prompt,
      info: () => (params.id ? { id: params.id } : undefined),
      imageAttachments: overrides?.imageAttachments ?? (() => []),
      commentCount: () => 0,
      permissionMode: () => "default",
      mode: () => overrides?.mode ?? "normal",
      working: () => false,
      editor: () => undefined,
      queueScroll: () => undefined,
      promptLength: (value) => value.reduce((sum, part) => sum + ("content" in part ? part.content.length : 0), 0),
      addToHistory: () => undefined,
      resetHistoryNavigation: () => undefined,
      setMode: () => undefined,
      setPopover: () => undefined,
      shouldQueue: overrides?.shouldQueue,
      onQueue: overrides?.onQueue,
      onAbort: overrides?.onAbort,
    })

  test("creates a native session and clears only after a durable delivery acknowledgement", async () => {
    externalEngine = "codex"
    codexSettings = { model: "gpt-6", effort: "high", permission: "workspace" }

    await create().handleSubmit(new Event("submit"))

    expect(createdSessions).toEqual([])
    expect(externalCreates).toEqual([
      expect.objectContaining({
        engine: "codex",
        location: { directory: "/repo/main" },
        delivery: "steer",
        input: {
          prompt: { text: "ls", files: [] },
          settings: codexSettings,
        },
      }),
    ])
    expect(resetCount).toBe(1)
    expect(externalRequest).toBeUndefined()
    expect(storedSessions["/repo/main"]?.[0]).toMatchObject({ id: "native-session" })
  })

  test("reuses the create request ID after an unknown result and preserves the input", async () => {
    externalEngine = "codex"
    externalDeliveryState = "unknown"
    const submit = create()

    await submit.handleSubmit(new Event("submit"))
    const first = externalCreates[0] as { requestID: string }

    expect(resetCount).toBe(0)
    expect(externalRequest).toMatchObject({ requestID: first.requestID, operation: "create" })

    params = { id: "native-session" }
    codexSettings = { model: "native-model", effort: "medium", permission: "workspace" }
    externalDeliveryState = "accepted"
    await submit.handleSubmit(new Event("submit"))

    expect((externalCreates[1] as { requestID: string }).requestID).toBe(first.requestID)
    expect(externalCreates[1]).toMatchObject({ input: { settings: {} } })
    expect(externalSubmits).toEqual([])
    expect(resetCount).toBe(1)
  })

  test("locks native creation per captured draft instead of swallowing another draft", async () => {
    externalEngine = "codex"
    externalCreateError = true
    const gate = Promise.withResolvers<void>()
    externalCreateGate = gate.promise
    let secondRequest: ExternalPromptRequest | undefined
    const secondValue: Prompt = [{ type: "text", content: "second", start: 0, end: 6 }]
    const second = {
      ...prompt,
      current: () => secondValue,
      externalRequest: {
        current: () => secondRequest,
        set: (value: ExternalPromptRequest | undefined) => {
          secondRequest = value
        },
      },
      capture: () => second,
    }
    const submit = create()

    const first = submit.handleSubmit(new Event("submit"))
    await Bun.sleep(0)
    alternatePrompt = second
    const next = submit.handleSubmit(new Event("submit"))
    await Bun.sleep(0)

    expect(externalCreates).toHaveLength(2)
    gate.resolve()
    await Promise.all([first, next])
  })

  test("uses the native queue and interrupt actions for existing Codex sessions", async () => {
    externalEngine = "codex"
    params = { id: "native-session" }
    let queued = false
    let legacyAbort = false
    const submit = create({
      shouldQueue: () => true,
      onQueue: () => {
        queued = true
      },
      onAbort: () => {
        legacyAbort = true
      },
    })

    await submit.handleSubmit(new Event("submit"))
    await submit.abort()

    expect(externalSubmits).toEqual([expect.objectContaining({ sessionID: "native-session", delivery: "queue" })])
    expect(queued).toBeFalse()
    expect(externalInterrupts).toEqual(["native-session"])
    expect(legacyAbort).toBeFalse()
    expect(todoClears).toBe(0)
  })

  test("submits the complete desired settings including pending changes", async () => {
    externalEngine = "codex"
    params = { id: "native-session" }
    codexSettings = { model: "gpt-5", effort: "medium", permission: "readOnly" }
    codexPendingSettings = { model: "gpt-6", effort: "high", permission: "workspace" }

    await create().handleSubmit(new Event("submit"))

    expect(externalSubmits).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({ settings: codexPendingSettings }),
      }),
    ])
  })

  test("captures existing native settings before asynchronous image encoding", async () => {
    externalEngine = "codex"
    params = { id: "native-session" }
    codexSettings = { model: "gpt-5", effort: "medium", permission: "readOnly" }
    const gate = Promise.withResolvers<void>()
    imageEncodeGate = gate.promise
    const pending = create({
      imageAttachments: () => [
        {
          type: "image",
          id: "image",
          filename: "image.png",
          mime: "image/png",
          blob: { id: "image", url: "blob:image" },
        },
      ],
    }).handleSubmit(new Event("submit"))

    await Bun.sleep(0)
    codexSettings.model = "gpt-6"
    gate.resolve()
    await pending

    expect(externalSubmits).toEqual([
      expect.objectContaining({
        input: expect.objectContaining({
          settings: { model: "gpt-5", effort: "medium", permission: "readOnly" },
        }),
      }),
    ])
  })

  test("keeps an unknown queued delivery identity when the session becomes idle before retry", async () => {
    externalEngine = "codex"
    externalDeliveryState = "unknown"
    params = { id: "native-session" }
    let queue = true
    const submit = create({ shouldQueue: () => queue })

    await submit.handleSubmit(new Event("submit"))
    const first = externalSubmits[0] as { requestID: string; delivery: string }
    queue = false
    externalDeliveryState = "accepted"
    await submit.handleSubmit(new Event("submit"))

    expect(externalDeliveryChecks).toEqual([{ sessionID: "native-session", requestID: first.requestID }])
    expect(externalSubmits).toHaveLength(2)
    expect(externalSubmits[1]).toMatchObject({ requestID: first.requestID, delivery: "queue" })
  })

  test("checks and reuses a durable receipt before resubmitting the same intent", async () => {
    externalEngine = "codex"
    externalDeliveryState = "unknown"
    params = { id: "native-session" }
    const submit = create({ shouldQueue: () => true })

    await submit.handleSubmit(new Event("submit"))
    externalCheckedState = "accepted"
    await submit.handleSubmit(new Event("submit"))

    expect(externalDeliveryChecks).toHaveLength(1)
    expect(externalSubmits).toHaveLength(1)
    expect(resetCount).toBe(1)
  })

  test("does not clear text when the user changes Codex settings before a late acknowledgement", async () => {
    externalEngine = "codex"
    params = { id: "native-session" }
    const gate = Promise.withResolvers<void>()
    externalSubmitGate = gate.promise
    const submit = create()

    const pending = submit.handleSubmit(new Event("submit"))
    await Bun.sleep(0)
    prompt.codex.set({ model: "new-model", effort: "high", permission: "full" })
    gate.resolve()
    await pending

    expect(resetCount).toBe(0)
    expect(promptValue).toEqual([{ type: "text", content: "ls", start: 0, end: 2 }])
    expect(externalRequest).toBeUndefined()
  })

  test("does not clear newer text when an older Codex acknowledgement arrives", async () => {
    externalEngine = "codex"
    params = { id: "native-session" }
    const gate = Promise.withResolvers<void>()
    externalSubmitGate = gate.promise
    const submit = create()

    const pending = submit.handleSubmit(new Event("submit"))
    await Bun.sleep(0)
    promptValue = [{ type: "text", content: "newer", start: 0, end: 5 }]
    gate.resolve()
    await pending

    expect(resetCount).toBe(0)
    expect(promptValue[0]).toMatchObject({ content: "newer" })
  })

  for (const unavailable of ["disconnected", "systemError", "bindingUnavailable"] as const) {
    test(`does not submit while the native descriptor is ${unavailable}`, async () => {
      externalEngine = "codex"
      externalRuntimeStatus = unavailable
      params = { id: "native-session" }

      await create().handleSubmit(new Event("submit"))

      expect(externalSubmits).toEqual([])
      expect(resetCount).toBe(0)
    })
  }

  test("does not submit when the native descriptor does not accept prompts", async () => {
    externalEngine = "codex"
    externalPromptCapability = false
    params = { id: "native-session" }

    await create().handleSubmit(new Event("submit"))

    expect(externalSubmits).toEqual([])
    expect(resetCount).toBe(0)
  })

  test("rejects OpenCode shell, custom command, and agent mention inputs before native delivery", async () => {
    externalEngine = "codex"
    await create({ mode: "shell" }).handleSubmit(new Event("submit"))

    commands.push({ name: "review" })
    promptValue = [{ type: "text", content: "/review", start: 0, end: 7 }]
    await create().handleSubmit(new Event("submit"))

    commands.length = 0
    promptValue = [
      { type: "text", content: "ask ", start: 0, end: 4 },
      { type: "agent", name: "reviewer", content: "@reviewer", start: 4, end: 13 },
    ]
    await create().handleSubmit(new Event("submit"))

    expect(externalCreates).toEqual([])
    expect(externalSubmits).toEqual([])
    expect(resetCount).toBe(0)
  })
})
