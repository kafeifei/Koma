import { expect, test } from "bun:test"
import { toolPresentationName } from "./tool-presentation"

test("native and historical tool names share the existing renderer", () => {
  for (const name of ["bash", "shell", "codex.commandExecution"]) expect(toolPresentationName(name)).toBe("shell")
  for (const name of ["patch", "apply_patch", "codex.fileChange"]) expect(toolPresentationName(name)).toBe("patch")
  expect(toolPresentationName("codex.webSearch")).toBe("websearch")
  expect(toolPresentationName("codex.subagent")).toBe("task")
  expect(toolPresentationName("unknown.tool")).toBe("unknown.tool")
})
