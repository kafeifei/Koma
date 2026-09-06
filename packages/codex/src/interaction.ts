import { SessionExternal } from "@opencode-ai/schema/session-external"
import type { CodexServerRequest, CodexServerRequestResult } from "./transport"
import { toBrowserValue } from "./projection"

type Pending = {
  view: SessionExternal.Interaction
  reply: (reply: SessionExternal.Reply) => CodexServerRequestResult
}

export async function createCodexInteraction(
  request: CodexServerRequest,
  target: Pick<SessionExternal.Interaction, "id" | "sessionID" | "revision">,
): Promise<Pending | undefined> {
  if (!record(request.params)) return
  const params = request.params
  const base = {
    ...target,
    turnRef: string(params.turnId),
    itemRef: string(params.itemId),
    title: string(params.command) ?? string(params.message) ?? string(params.reason) ?? "",
    description: string(params.reason),
    details: toBrowserValue(params),
    state: "pending" as const,
  }
  if (request.method === "item/commandExecution/requestApproval") {
    if (
      params.availableDecisions !== undefined &&
      params.availableDecisions !== null &&
      !Array.isArray(params.availableDecisions)
    ) {
      throw new Error("Invalid native command approval decisions")
    }
    if (Array.isArray(params.availableDecisions) && !params.availableDecisions.length) {
      throw new Error("Native command approval provided no decisions")
    }
    // Codex 0.153.4 computes richer effective defaults before app-server sends
    // the request. Older or stripped payloads can omit the experimental list;
    // keep only the protocol's one-shot accept and interrupting cancel choices.
    const decisions = Array.isArray(params.availableDecisions)
      ? params.availableDecisions.map((decision) => requireCommandDecision(decision))
      : ["accept", "cancel"]
    const choices = decisions.map((decision, index) => ({
      id: `choice-${index}`,
      kind: decisionKind(decision),
      ...(typeof decision === "object" ? { label: JSON.stringify(decision) } : {}),
    }))
    return {
      view: { ...base, kind: "command", choices },
      reply: (reply) => ({ result: { decision: requireChoice(reply, choices, decisions) } }),
    }
  }
  if (request.method === "item/fileChange/requestApproval") {
    const decisions = [
      "accept" as const,
      ...(typeof params.grantRoot === "string" && params.grantRoot ? ["acceptForSession" as const] : []),
      "decline" as const,
      "cancel" as const,
    ]
    const choices = decisions.map((decision, index) => ({ id: `choice-${index}`, kind: decisionKind(decision) }))
    return {
      view: { ...base, kind: "file", choices },
      reply: (reply) => ({ result: { decision: requireChoice(reply, choices, decisions) } }),
    }
  }
  if (request.method === "item/permissions/requestApproval") {
    if (!record(params.permissions)) throw new Error("Invalid native permission request")
    const requested = Object.fromEntries(Object.entries(params.permissions).filter(([, value]) => value !== null))
    const choices = [
      { id: "allow-turn", kind: "allow" as const, scope: "turn" },
      { id: "allow-session", kind: "allowSession" as const, scope: "session" },
      { id: "deny", kind: "deny" as const },
    ]
    return {
      view: { ...base, kind: "permissions", choices },
      reply(reply) {
        requireChoice(reply, choices, choices)
        if (reply.choiceID === "deny") return { result: { permissions: {}, scope: "turn" } }
        const permissions = reply.content ?? requested
        if (!record(permissions) || !isSubset(permissions, requested))
          throw new Error("Granted permissions exceed the native request")
        return { result: { permissions, scope: reply.choiceID === "allow-session" ? "session" : "turn" } }
      },
    }
  }
  if (request.method === "item/tool/requestUserInput") {
    if (!Array.isArray(params.questions) || !params.questions.length) throw new Error("Invalid native questions")
    const questions = params.questions.map((item) => {
      if (
        !record(item) ||
        !string(item.id) ||
        typeof item.header !== "string" ||
        typeof item.question !== "string" ||
        typeof item.isOther !== "boolean" ||
        typeof item.isSecret !== "boolean" ||
        (item.options !== null && !Array.isArray(item.options))
      ) {
        throw new Error("Invalid native question")
      }
      return {
        id: item.id as string,
        header: item.header,
        question: item.question,
        allowOther: item.isOther,
        secret: item.isSecret,
        options: Array.isArray(item.options)
          ? item.options.map((option) => {
              if (!record(option) || typeof option.label !== "string" || typeof option.description !== "string") {
                throw new Error("Invalid native question option")
              }
              return { label: option.label, description: option.description }
            })
          : undefined,
      }
    })
    if (new Set(questions.map((question) => question.id)).size !== questions.length) {
      throw new Error("Duplicate native question ID")
    }
    return {
      view: { ...base, kind: "question", choices: [], questions },
      reply(reply) {
        const answers = reply.answers ?? {}
        if (Object.keys(answers).some((id) => !questions.some((question) => question.id === id)))
          throw new Error("Unknown question ID")
        return {
          result: {
            answers: Object.fromEntries(
              questions.map((question) => {
                const selected = answers[question.id]
                if (!selected?.length) throw new Error("Every question needs an answer")
                if (selected.some((text) => typeof text !== "string" || !text.length))
                  throw new Error("Invalid native answer")
                if (
                  question.options?.length &&
                  !question.allowOther &&
                  selected.some((text) => !question.options!.some((option) => option.label === text))
                ) {
                  throw new Error("Answer is not one of the native options")
                }
                return [question.id, { answers: [...selected] }]
              }),
            ),
          },
        }
      },
    }
  }
  if (request.method !== "mcpServer/elicitation/request") return
  const url = params.mode === "url"
  if (!url && params.mode !== "form") throw new Error("Unsupported MCP elicitation mode")
  const webURL = url ? requireWebURL(params.url) : undefined
  if (!url) requireMcpFormSchema(params.requestedSchema)
  const validate = await (async () => {
    if (url) return undefined
    const { Ajv } = await import("ajv")
    const schema = { ...(params.requestedSchema as Record<string, unknown>) }
    delete schema.$schema
    return new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(schema)
  })()
  const choices = [
    { id: "accept", kind: "allow" as const },
    { id: "decline", kind: "deny" as const },
    { id: "cancel", kind: "cancel" as const },
  ]
  return {
    view: {
      ...base,
      kind: url ? "url" : "form",
      choices,
      url: webURL,
      requestedSchema: url ? undefined : toBrowserValue(params.requestedSchema),
    },
    reply(reply) {
      requireChoice(reply, choices, choices)
      if (reply.choiceID !== "accept") return { result: { action: reply.choiceID, content: null, _meta: null } }
      if (
        validate &&
        (!record(reply.content) ||
          hasUnknownProperties(reply.content, params.requestedSchema) ||
          !validate(reply.content))
      ) {
        throw new Error("MCP form does not match the requested schema")
      }
      return { result: { action: "accept", content: url ? null : reply.content, _meta: null } }
    },
  }
}

function requireChoice<T>(
  reply: SessionExternal.Reply,
  choices: ReadonlyArray<{ id: string }>,
  values: ReadonlyArray<T>,
): T {
  const index = choices.findIndex((choice) => choice.id === reply.choiceID)
  if (index < 0) throw new Error("Unknown native decision")
  return values[index]!
}

function decisionKind(value: unknown): SessionExternal.Interaction["choices"][number]["kind"] {
  if (value === "accept") return "allow"
  if (value === "acceptForSession") return "allowSession"
  if (value === "decline") return "deny"
  if (value === "cancel") return "cancel"
  return "custom"
}

function requireCommandDecision(value: unknown) {
  if (["accept", "acceptForSession", "decline", "cancel"].includes(string(value) ?? "")) return value
  if (!record(value)) throw new Error("Invalid native command approval decision")
  if (record(value.acceptWithExecpolicyAmendment)) {
    requireKeys(value, ["acceptWithExecpolicyAmendment"])
    requireKeys(value.acceptWithExecpolicyAmendment, ["execpolicy_amendment"])
    const amendment = value.acceptWithExecpolicyAmendment.execpolicy_amendment
    if (!Array.isArray(amendment) || !amendment.length || amendment.some((part) => typeof part !== "string")) {
      throw new Error("Invalid native command approval decision")
    }
    return value
  }
  if (record(value.applyNetworkPolicyAmendment)) {
    requireKeys(value, ["applyNetworkPolicyAmendment"])
    requireKeys(value.applyNetworkPolicyAmendment, ["network_policy_amendment"])
    const amendment = value.applyNetworkPolicyAmendment.network_policy_amendment
    if (!record(amendment)) throw new Error("Invalid native command approval decision")
    requireKeys(amendment, ["host", "action"])
    if (typeof amendment.host !== "string" || !["allow", "deny"].includes(string(amendment.action) ?? "")) {
      throw new Error("Invalid native command approval decision")
    }
    return value
  }
  throw new Error("Invalid native command approval decision")
}

function requireWebURL(value: unknown) {
  if (typeof value !== "string" || !URL.canParse(value)) throw new Error("Invalid MCP elicitation URL")
  const protocol = new URL(value).protocol
  if (protocol !== "http:" && protocol !== "https:") throw new Error("Unsupported MCP elicitation URL scheme")
  return value
}

function requireMcpFormSchema(value: unknown) {
  if (!record(value) || value.type !== "object" || !record(value.properties)) {
    throw new Error("Unsupported MCP elicitation schema")
  }
  const properties = value.properties
  requireKeys(value, ["$schema", "type", "properties", "required"])
  if (value.$schema !== undefined && value.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    throw new Error("Unsupported MCP elicitation schema dialect")
  }
  if (
    value.required !== undefined &&
    (!Array.isArray(value.required) ||
      value.required.some((name) => typeof name !== "string" || !Object.hasOwn(properties, name)))
  ) {
    throw new Error("Invalid MCP elicitation required fields")
  }
  Object.values(properties).forEach((property) => requireMcpPropertySchema(property))
}

function requireMcpPropertySchema(value: unknown) {
  if (!record(value)) throw new Error("Unsupported MCP elicitation property schema")
  if (value.type === "string") {
    if (value.format !== undefined) throw new Error("Unsupported MCP elicitation string format")
    if (value.oneOf !== undefined) {
      requireKeys(value, ["type", "title", "description", "oneOf", "default"])
      requireConstOptions(value.oneOf)
      return
    }
    if (value.enum !== undefined) {
      requireKeys(value, ["type", "title", "description", "enum", "enumNames", "default"])
      requireStringList(value.enum, "Invalid MCP elicitation enum")
      if (value.enumNames !== undefined) {
        requireStringList(value.enumNames, "Invalid MCP elicitation enum titles")
        if (value.enumNames.length !== value.enum.length) throw new Error("Invalid MCP elicitation enum titles")
      }
      return
    }
    requireKeys(value, ["type", "title", "description", "minLength", "maxLength", "default"])
    return
  }
  if (value.type === "number" || value.type === "integer") {
    requireKeys(value, ["type", "title", "description", "minimum", "maximum", "default"])
    return
  }
  if (value.type === "boolean") {
    requireKeys(value, ["type", "title", "description", "default"])
    return
  }
  if (value.type !== "array") throw new Error("Unsupported MCP elicitation property schema")
  requireKeys(value, ["type", "title", "description", "minItems", "maxItems", "items", "default"])
  if (!record(value.items)) throw new Error("Unsupported MCP elicitation array items")
  if (value.items.anyOf !== undefined) {
    requireKeys(value.items, ["anyOf"])
    requireConstOptions(value.items.anyOf)
    return
  }
  requireKeys(value.items, ["type", "enum"])
  if (value.items.type !== "string") throw new Error("Unsupported MCP elicitation array items")
  requireStringList(value.items.enum, "Invalid MCP elicitation enum")
}

function requireConstOptions(value: unknown) {
  if (!Array.isArray(value) || !value.length) throw new Error("Invalid MCP elicitation options")
  value.forEach((option) => {
    if (!record(option)) throw new Error("Invalid MCP elicitation option")
    requireKeys(option, ["const", "title"])
    if (typeof option.const !== "string" || typeof option.title !== "string") {
      throw new Error("Invalid MCP elicitation option")
    }
  })
}

function requireStringList(value: unknown, message: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string")) throw new Error(message)
}

function requireKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Unsupported MCP elicitation schema keyword")
}

function hasUnknownProperties(content: Record<string, unknown>, schema: unknown) {
  if (!record(schema) || !record(schema.properties)) return true
  const properties = schema.properties
  return Object.keys(content).some((key) => !Object.hasOwn(properties, key))
}

function isSubset(granted: unknown, requested: unknown): boolean {
  if (granted === requested) return true
  if (Array.isArray(granted))
    return Array.isArray(requested) && granted.every((item) => requested.some((value) => isSubset(item, value)))
  if (!record(granted) || !record(requested)) return false
  return Object.entries(granted).every(
    ([key, value]) => Object.hasOwn(requested, key) && isSubset(value, requested[key]),
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function string(value: unknown) {
  return typeof value === "string" ? value : undefined
}
