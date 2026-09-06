import { describe, expect, test } from "bun:test"
import { SessionExternal } from "@opencode-ai/schema/session-external"
import { createCodexInteraction } from "../src/interaction.js"
import type { CodexServerRequest } from "../src/transport.js"

const target = {
  id: "interaction-1",
  sessionID: "session-1",
  revision: 1,
} as Pick<SessionExternal.Interaction, "id" | "sessionID" | "revision">

function request(method: string, params: unknown): CodexServerRequest {
  return { generation: 1, id: 7, method, params }
}

describe("createCodexInteraction", () => {
  test("presents an explicit native command decision list exactly", async () => {
    const pending = await createCodexInteraction(
      request("item/commandExecution/requestApproval", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        command: "echo safe",
        availableDecisions: ["decline", "cancel"],
      }),
      target,
    )

    expect(pending?.view.choices).toEqual([
      { id: "choice-0", kind: "deny" },
      { id: "choice-1", kind: "cancel" },
    ])
    expect(pending?.reply({ revision: 1, choiceID: "choice-0" })).toEqual({ result: { decision: "decline" } })
  })

  test("uses only one-shot accept and cancel when the experimental decision list is absent", async () => {
    const missing = await createCodexInteraction(
      request("item/commandExecution/requestApproval", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
      }),
      target,
    )
    const nullable = await createCodexInteraction(
      request("item/commandExecution/requestApproval", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        availableDecisions: null,
      }),
      target,
    )

    expect(missing?.view.choices).toEqual([
      { id: "choice-0", kind: "allow" },
      { id: "choice-1", kind: "cancel" },
    ])
    expect(nullable?.view.choices).toEqual(missing?.view.choices)
    expect(missing?.reply({ revision: 1, choiceID: "choice-0" })).toEqual({ result: { decision: "accept" } })
    expect(missing?.reply({ revision: 1, choiceID: "choice-1" })).toEqual({ result: { decision: "cancel" } })
  })

  test("does not widen an explicitly empty native decision list", async () => {
    await expect(
      createCodexInteraction(
        request("item/commandExecution/requestApproval", {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          availableDecisions: [],
        }),
        target,
      ),
    ).rejects.toThrow("provided no decisions")
  })

  test("round-trips a native structured command decision without widening it", async () => {
    const decision = {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { host: "api.example.com", action: "allow" },
      },
    }
    const pending = await createCodexInteraction(
      request("item/commandExecution/requestApproval", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        availableDecisions: [decision],
      }),
      target,
    )

    expect(pending?.view.choices).toEqual([{ id: "choice-0", kind: "custom", label: JSON.stringify(decision) }])
    expect(pending?.reply({ revision: 1, choiceID: "choice-0" })).toEqual({ result: { decision } })
    await expect(
      createCodexInteraction(
        request("item/commandExecution/requestApproval", {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          availableDecisions: [{ inventedDecision: true }],
        }),
        target,
      ),
    ).rejects.toThrow("Invalid native command approval decision")
  })

  test("offers file session approval only when Codex supplies a grant root", async () => {
    const once = await createCodexInteraction(
      request("item/fileChange/requestApproval", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        grantRoot: null,
      }),
      target,
    )
    const session = await createCodexInteraction(
      request("item/fileChange/requestApproval", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        grantRoot: "/workspace",
      }),
      target,
    )

    expect(once?.view.choices.map((choice) => choice.kind)).toEqual(["allow", "deny", "cancel"])
    expect(session?.view.choices.map((choice) => choice.kind)).toEqual(["allow", "allowSession", "deny", "cancel"])
  })

  test("cannot grant permissions outside the native request", async () => {
    const pending = await createCodexInteraction(
      request("item/permissions/requestApproval", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        permissions: { network: { enabled: true }, fileSystem: null },
      }),
      target,
    )

    expect(() =>
      pending?.reply({
        revision: 1,
        choiceID: "allow-turn",
        content: { network: { enabled: true }, fileSystem: { write: ["/outside"] } },
      }),
    ).toThrow("exceed")
    expect(pending?.reply({ revision: 1, choiceID: "deny" })).toEqual({
      result: { permissions: {}, scope: "turn" },
    })
  })

  test("preserves native question IDs, options, and secret presentation", async () => {
    const pending = await createCodexInteraction(
      request("item/tool/requestUserInput", {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        isBlocking: true,
        questions: [
          {
            id: "native-secret",
            header: "Token",
            question: "Enter the token",
            isOther: true,
            isSecret: true,
            options: null,
          },
          {
            id: "native-choice",
            header: "Mode",
            question: "Select a mode",
            isOther: false,
            isSecret: false,
            options: [{ label: "safe", description: "Use the safe mode" }],
          },
        ],
      }),
      target,
    )

    expect(pending?.view.questions).toEqual([
      {
        id: "native-secret",
        header: "Token",
        question: "Enter the token",
        allowOther: true,
        secret: true,
        options: undefined,
      },
      {
        id: "native-choice",
        header: "Mode",
        question: "Select a mode",
        allowOther: false,
        secret: false,
        options: [{ label: "safe", description: "Use the safe mode" }],
      },
    ])
    expect(
      pending?.reply({
        revision: 1,
        answers: { "native-choice": ["safe"], "native-secret": ["hidden"] },
      }),
    ).toEqual({
      result: {
        answers: {
          "native-secret": { answers: ["hidden"] },
          "native-choice": { answers: ["safe"] },
        },
      },
    })
    expect(() =>
      pending?.reply({
        revision: 1,
        answers: { "native-choice": ["invented"], "native-secret": ["hidden"] },
      }),
    ).toThrow("not one of the native options")
  })

  test("validates supported MCP forms and rejects unrequested fields", async () => {
    const pending = await createCodexInteraction(
      request("mcpServer/elicitation/request", {
        threadId: "thread-1",
        turnId: null,
        serverName: "example",
        mode: "form",
        message: "Configure the action",
        _meta: null,
        requestedSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            name: { type: "string", minLength: 2 },
            count: { type: "integer", minimum: 1 },
            mode: { type: "string", enum: ["safe", "fast"] },
            tags: { type: "array", items: { type: "string", enum: ["reviewed", "tested"] } },
          },
          required: ["name", "mode"],
        },
      }),
      target,
    )

    expect(pending?.view.kind).toBe("form")
    const content = { name: "ok", count: 2, mode: "safe", tags: ["tested"] }
    expect(pending?.reply({ revision: 1, choiceID: "accept", content })).toEqual({
      result: { action: "accept", content, _meta: null },
    })
    expect(() =>
      pending?.reply({ revision: 1, choiceID: "accept", content: { name: "ok", mode: "safe", extra: true } }),
    ).toThrow("does not match")
    expect(() => pending?.reply({ revision: 1, choiceID: "accept", content: { name: "x", mode: "safe" } })).toThrow(
      "does not match",
    )
  })

  test("rejects unsupported form semantics and non-web elicitation URLs", async () => {
    await expect(
      createCodexInteraction(
        request("mcpServer/elicitation/request", {
          threadId: "thread-1",
          turnId: null,
          serverName: "example",
          mode: "form",
          message: "Email",
          _meta: null,
          requestedSchema: {
            type: "object",
            properties: { email: { type: "string", format: "email" } },
          },
        }),
        target,
      ),
    ).rejects.toThrow("string format")
    await expect(
      createCodexInteraction(
        request("mcpServer/elicitation/request", {
          threadId: "thread-1",
          turnId: null,
          serverName: "example",
          mode: "openai/form",
          message: "Extension form",
          _meta: null,
          requestedSchema: {},
        }),
        target,
      ),
    ).rejects.toThrow("mode")
    await expect(
      createCodexInteraction(
        request("mcpServer/elicitation/request", {
          threadId: "thread-1",
          turnId: null,
          serverName: "example",
          mode: "url",
          message: "Open this",
          _meta: null,
          url: "javascript:alert(1)",
          elicitationId: "elicit-1",
        }),
        target,
      ),
    ).rejects.toThrow("URL scheme")

    const web = await createCodexInteraction(
      request("mcpServer/elicitation/request", {
        threadId: "thread-1",
        turnId: null,
        serverName: "example",
        mode: "url",
        message: "Open this",
        _meta: null,
        url: "https://example.com/continue",
        elicitationId: "elicit-1",
      }),
      target,
    )
    expect(web?.view.url).toBe("https://example.com/continue")
    expect(web?.reply({ revision: 1, choiceID: "accept" })).toEqual({
      result: { action: "accept", content: null, _meta: null },
    })
  })
})
