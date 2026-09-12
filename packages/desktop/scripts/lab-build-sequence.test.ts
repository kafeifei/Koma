import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withKomaBuildSequence } from "./koma-build-sequence"

describe("withKomaBuildSequence", () => {
  test("starts at one and increments shared state", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lab-build-sequence-"))
    try {
      expect(await withKomaBuildSequence(directory, async (sequence) => sequence)).toBe(1)
      expect(await withKomaBuildSequence(directory, async (sequence) => sequence)).toBe(2)
      expect(await readFile(join(directory, "lab-build-sequence"), "utf8")).toBe("2\n")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("serializes concurrent allocations without duplicates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lab-build-sequence-"))
    try {
      const values = await Promise.all(
        Array.from({ length: 8 }, () => withKomaBuildSequence(directory, async (sequence) => sequence)),
      )
      expect(values.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("fails closed when state is corrupt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lab-build-sequence-"))
    try {
      await writeFile(join(directory, "lab-build-sequence"), "not-a-sequence\n")
      await expect(withKomaBuildSequence(directory, async (sequence) => sequence)).rejects.toThrow(
        "Invalid Koma build sequence state",
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("failed builds keep the last successful number and release the reservation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lab-build-sequence-"))
    try {
      await writeFile(join(directory, "lab-build-sequence"), "42\n")
      await expect(
        withKomaBuildSequence(directory, async (sequence) => {
          expect(sequence).toBe(43)
          expect(await readFile(join(directory, "lab-build-sequence"), "utf8")).toBe("42\n")
          throw new Error("compiler failed")
        }),
      ).rejects.toThrow("compiler failed")
      expect(await readFile(join(directory, "lab-build-sequence"), "utf8")).toBe("42\n")
      expect(await withKomaBuildSequence(directory, async (sequence) => sequence)).toBe(43)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("a waiting build reuses a failed reservation only after its owner finishes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lab-build-sequence-"))
    const started = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    try {
      const first = withKomaBuildSequence(directory, async (sequence) => {
        expect(sequence).toBe(1)
        started.resolve()
        await finish.promise
        throw new Error("build failed")
      })
      const failed = first.catch((error: Error) => error.message)
      await started.promise
      const second = withKomaBuildSequence(directory, async (sequence) => sequence)
      finish.resolve()
      expect(await failed).toBe("build failed")
      expect(await second).toBe(1)
      expect(await readFile(join(directory, "lab-build-sequence"), "utf8")).toBe("1\n")
    } finally {
      finish.resolve()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
