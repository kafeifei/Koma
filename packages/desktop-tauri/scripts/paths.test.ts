import { expect, test } from "bun:test"
import { join } from "node:path"
import { homedir } from "node:os"
import { assertTestPath, profile, testRoot } from "./paths"

test("only scoped test paths are accepted", () => {
  expect(assertTestPath(profile)).toBe(profile)
  for (const path of [homedir(), join(homedir(), ".opencode"), testRoot, join(testRoot, "../production")]) {
    expect(() => assertTestPath(path)).toThrow()
  }
})
