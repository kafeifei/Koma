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
