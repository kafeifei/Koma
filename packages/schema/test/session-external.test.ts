import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionExternal } from "../src/session-external"

describe("external session permission settings", () => {
  test.each(["default", "auto", "full", "workspace", "readOnly"])(
    "preserves %s without changing authority",
    (permission) => {
      const settings = Schema.decodeUnknownSync(SessionExternal.Settings)({ permission })
      expect(Schema.encodeSync(SessionExternal.Settings)(settings)).toEqual({ permission })
    },
  )

  test("omits an unspecified permission instead of applying a default to an existing session", () => {
    expect(Schema.encodeSync(SessionExternal.Settings)({ model: "fixture", permission: undefined })).toEqual({
      model: "fixture",
    })
    expect(() => Schema.decodeUnknownSync(SessionExternal.Settings)({ permission: "native" })).toThrow()
  })
})

describe("external engine model authentication", () => {
  const engine = {
    id: "codex" as const,
    available: true,
    account: { authenticated: false, requiresAuth: true },
    capabilities: {
      prompt: true,
      steer: true,
      queue: "native" as const,
      compact: true,
      images: true,
      permissions: true,
    },
  }

  test("preserves an explicit model authentication override", () => {
    const decoded = Schema.decodeUnknownSync(SessionExternal.Engine)({
      ...engine,
      models: [{ id: "xd/gpt-5", name: "XD GPT-5", default: false, efforts: [], requiresAuth: false }],
    })

    expect(Schema.encodeSync(SessionExternal.Engine)(decoded).models[0]?.requiresAuth).toBeFalse()
  })

  test("omits model authentication when a provider does not specify it", () => {
    const decoded = Schema.decodeUnknownSync(SessionExternal.Engine)({
      ...engine,
      models: [{ id: "gpt-5", name: "GPT-5", default: true, efforts: [] }],
    })

    expect(Schema.encodeSync(SessionExternal.Engine)(decoded).models[0]).not.toHaveProperty("requiresAuth")
  })
})
