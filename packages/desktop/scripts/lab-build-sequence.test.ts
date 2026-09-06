import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { nextLabBuildSequence } from "./lab-build-sequence"

describe("nextLabBuildSequence", () => {
  test("starts at one and increments shared state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lab-build-sequence-"))
    try {
      expect(await nextLabBuildSequence(directory)).toBe(1)
      expect(await nextLabBuildSequence(directory)).toBe(2)
      expect(await readFile(join(directory, "lab-build-sequence"), "utf8")).toBe("2\n")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("serializes concurrent allocations without duplicates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lab-build-sequence-"))
    try {
      const values = await Promise.all(Array.from({ length: 8 }, () => nextLabBuildSequence(directory)))
      expect(values.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("fails closed when state is corrupt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lab-build-sequence-"))
    try {
      await writeFile(join(directory, "lab-build-sequence"), "not-a-sequence\n")
      await expect(nextLabBuildSequence(directory)).rejects.toThrow("Invalid Lab build sequence state")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
