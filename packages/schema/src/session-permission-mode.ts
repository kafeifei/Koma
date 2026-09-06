import { Schema } from "effect"

export const PermissionMode = Schema.Literals(["default", "auto", "full"]).annotate({
  identifier: "SessionPermissionMode",
})
export type PermissionMode = typeof PermissionMode.Type
