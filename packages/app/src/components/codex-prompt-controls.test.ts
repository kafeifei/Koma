import { describe, expect, test } from "bun:test"
import {
  canSubmitWithCodexAccount,
  desiredCodexSettings,
  sharedCodexPermission,
  updateCodexSettings,
} from "./codex-prompt-controls"

describe("Codex prompt settings", () => {
  test("preserves applied and pending fields across consecutive setting changes", () => {
    const applied = { model: "gpt-5", effort: "medium", permission: "readOnly" as const }
    const model = updateCodexSettings(desiredCodexSettings({ settings: applied }, {}), { model: "gpt-6" })
    const effort = updateCodexSettings(desiredCodexSettings({ settings: applied, pendingSettings: model }, {}), {
      effort: "high",
    })
    const permission = updateCodexSettings(desiredCodexSettings({ settings: applied, pendingSettings: effort }, {}), {
      permission: "workspace",
    })

    expect(permission).toEqual({ model: "gpt-6", effort: "high", permission: "workspace" })
  })

  test("uses a saved unavailable model instead of displaying the advertised default", () => {
    expect(
      desiredCodexSettings(
        { settings: { model: "retired-model" }, pendingSettings: { effort: "high" } },
        { model: "draft-model" },
      ),
    ).toEqual({ model: "retired-model", effort: "high" })
  })

  test("maps only shared Codex permission modes into the common picker", () => {
    expect(sharedCodexPermission("workspace")).toBe("default")
    expect(sharedCodexPermission("default")).toBe("default")
    expect(sharedCodexPermission("auto")).toBe("auto")
    expect(sharedCodexPermission("full")).toBe("full")
    expect(sharedCodexPermission("readOnly")).toBeUndefined()
    expect(sharedCodexPermission(undefined)).toBeUndefined()
  })

  test("allows an unauthenticated account only for a selected model that explicitly skips auth", () => {
    const account = { authenticated: false, requiresAuth: true }

    expect(canSubmitWithCodexAccount(account, { requiresAuth: false })).toBeTrue()
    expect(canSubmitWithCodexAccount(account, { requiresAuth: true })).toBeFalse()
    expect(canSubmitWithCodexAccount(account, {})).toBeFalse()
    expect(canSubmitWithCodexAccount(account, undefined)).toBeFalse()
  })

  test("keeps the account-level behavior when authentication is already satisfied", () => {
    expect(canSubmitWithCodexAccount({ authenticated: true, requiresAuth: true }, undefined)).toBeTrue()
    expect(canSubmitWithCodexAccount({ authenticated: false, requiresAuth: false }, undefined)).toBeTrue()
    expect(canSubmitWithCodexAccount(undefined, { requiresAuth: false })).toBeFalse()
  })
})
