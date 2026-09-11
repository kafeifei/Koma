import { describe, expect, test } from "bun:test"
import type {
  AgentListOutput,
  ModelDefaultOutput,
  ModelListOutput,
  ProviderListOutput,
} from "@opencode-ai/client/promise"
import {
  createOpenedProjectResolver,
  dedupeOpenedProjects,
  directoryKey,
  normalizeAgentList,
  normalizePermissionRequest,
  normalizeProviderList,
} from "./utils"

describe("normalizeAgentList", () => {
  test("adapts current agents to the app agent shape", () => {
    const result = normalizeAgentList([
      {
        id: "build",
        name: "Build",
        mode: "primary",
        hidden: false,
        color: "primary",
        model: { id: "gpt-5", providerID: "openai", variant: "high" },
        request: { settings: { temperature: 0.2, topP: 0.9 }, headers: {}, body: {} },
        system: "Build software",
        permissions: [{ action: "read", resource: "*", effect: "allow" }],
      },
    ] as AgentListOutput["data"])

    expect(result).toEqual([
      {
        name: "build",
        description: undefined,
        mode: "primary",
        hidden: false,
        temperature: 0.2,
        topP: 0.9,
        color: "primary",
        permission: [{ permission: "read", pattern: "*", action: "allow" }],
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: "high",
        prompt: "Build software",
        options: { temperature: 0.2, topP: 0.9 },
        steps: undefined,
      },
    ])
  })
})

describe("normalizePermissionRequest", () => {
  test("adapts the current permission request to app state", () => {
    expect(
      normalizePermissionRequest({
        id: "permission-1",
        sessionID: "session-1",
        action: "read",
        resources: ["README.md"],
        save: ["*.md"],
        metadata: { path: "README.md" },
        source: { type: "tool", messageID: "message-1", callID: "call-1" },
      }),
    ).toEqual({
      id: "permission-1",
      sessionID: "session-1",
      permission: "read",
      patterns: ["README.md"],
      always: ["*.md"],
      metadata: { path: "README.md" },
      tool: { messageID: "message-1", callID: "call-1" },
    })
  })
})

describe("normalizeProviderList", () => {
  test("groups current models into the app provider catalog", () => {
    const result = normalizeProviderList(
      [{ id: "openai", name: "OpenAI", package: "@ai-sdk/openai" }] as ProviderListOutput["data"],
      [
        {
          id: "gpt-5",
          modelID: "gpt-5",
          providerID: "openai",
          name: "GPT-5",
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          variants: [{ id: "high" }],
          time: { released: 1 },
          cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
          status: "active",
          enabled: true,
          limit: { context: 128_000, output: 8_192 },
        },
        {
          id: "gpt-old",
          modelID: "gpt-old",
          providerID: "openai",
          name: "GPT Old",
          capabilities: { tools: false, input: ["text"], output: ["text"] },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "deprecated",
          enabled: true,
          limit: { context: 1, output: 1 },
        },
      ] as ModelListOutput["data"],
      { id: "gpt-5", providerID: "openai" } as ModelDefaultOutput["data"],
    )

    expect(result.connected).toEqual(["openai"])
    expect(result.defaultModel).toEqual({ providerID: "openai", modelID: "gpt-5" })
    expect(result.default).toEqual({ openai: "gpt-5" })
    expect(result.all.get("openai")?.models["gpt-old"]).toBeUndefined()
    expect(result.all.get("openai")?.models["gpt-5"]).toMatchObject({
      id: "gpt-5",
      providerID: "openai",
      capabilities: { toolcall: true, attachment: true },
      cost: { input: 1, output: 2 },
      variants: { high: {} },
    })
  })

  test("preserves an empty current default", () => {
    expect(normalizeProviderList([] as ProviderListOutput["data"], [], null).defaultModel).toBeNull()
  })
})

describe("directoryKey", () => {
  test("normalizes slashes", () => {
    expect(String(directoryKey("C:\\Repos\\sst\\opencode"))).toBe("C:/Repos/sst/opencode")
    expect(String(directoryKey("C:/Repos/sst/opencode"))).toBe("C:/Repos/sst/opencode")
  })

  test("preserves backslashes in posix paths", () => {
    expect(String(directoryKey("/tmp/foo\\bar"))).toBe("/tmp/foo\\bar")
  })

  test("trims trailing slashes without breaking roots", () => {
    expect(String(directoryKey("C:/Repos/sst/opencode/"))).toBe("C:/Repos/sst/opencode")
    expect(String(directoryKey("C:/"))).toBe("C:/")
    expect(String(directoryKey("/"))).toBe("/")
  })
})

describe("createOpenedProjectResolver", () => {
  test("maps only exact registered sandboxes to their canonical project", () => {
    const resolve = createOpenedProjectResolver([
      { worktree: "/code/repo", sandboxes: ["/worktrees/feature"] },
      { worktree: "/code/global", sandboxes: [] },
    ])

    expect(resolve("/worktrees/feature/")).toBe("/code/repo")
    expect(resolve("/code/repo/")).toBe("/code/repo")
    expect(resolve("/code/repo/packages/app")).toBe("/code/repo/packages/app")
    expect(resolve("/worktrees/unknown")).toBe("/worktrees/unknown")
    expect(resolve("/code/global")).toBe("/code/global")
  })

  test("resolves metadata chains and leaves cycles unchanged", () => {
    const chain = createOpenedProjectResolver([
      { worktree: "/code/repo", sandboxes: ["/worktrees/parent"] },
      { worktree: "/worktrees/parent", sandboxes: ["/worktrees/child"] },
    ])
    expect(chain("/worktrees/child")).toBe("/code/repo")

    const cycle = createOpenedProjectResolver([
      { worktree: "/worktrees/a", sandboxes: ["/worktrees/b"] },
      { worktree: "/worktrees/b", sandboxes: ["/worktrees/a"] },
    ])
    expect(cycle("/worktrees/a")).toBe("/worktrees/a")
    expect(cycle("/worktrees/b")).toBe("/worktrees/b")
  })
})

test("dedupeOpenedProjects preserves first position and expanded state", () => {
  expect(
    dedupeOpenedProjects([
      { worktree: "/code/repo", expanded: false },
      { worktree: "/code/repo/", expanded: true },
      { worktree: "/code/other", expanded: false },
    ]),
  ).toEqual([
    { worktree: "/code/repo", expanded: true },
    { worktree: "/code/other", expanded: false },
  ])
})
