import { expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildKoma } from "./build-koma"

test("full Lab build commits only after packaging succeeds, then standalone build advances once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lab-build-pipeline-"))
  try {
    const git = Bun.spawn(["git", "init", "--quiet", directory])
    expect(await git.exited).toBe(0)
    await writeFile(join(directory, ".git/lab-build-sequence"), "42\n")
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        scripts: {
          prebuild: "bun step.ts prepare",
          "electron-vite": "bun step.ts frontend",
          "package:debug": "bun step.ts package",
        },
      }),
    )
    await writeFile(
      join(directory, "step.ts"),
      `
      import { appendFileSync, existsSync, readFileSync } from "node:fs"
      const phase = process.argv[2]
      appendFileSync("stages", phase + ":" + process.env.OPENCODE_LAB_BUILD_SEQUENCE + ":" + readFileSync(".git/lab-build-sequence", "utf8").trim() + "\\n")
      if (existsSync("fail") && readFileSync("fail", "utf8") === phase) process.exit(1)
    `,
    )
    for (const phase of ["prepare", "frontend", "package"]) {
      await writeFile(join(directory, "fail"), phase)
      await expect(buildKoma(directory, true)).rejects.toThrow("failed (1)")
      expect(await readFile(join(directory, ".git/lab-build-sequence"), "utf8")).toBe("42\n")
    }
    await rm(join(directory, "fail"))
    expect(await buildKoma(directory, true)).toBe(43)
    expect(await readFile(join(directory, ".git/lab-build-sequence"), "utf8")).toBe("43\n")
    expect(await buildKoma(directory, false)).toBe(44)
    expect(await readFile(join(directory, "stages"), "utf8")).toBe(
      [
        "prepare:43:42",
        "prepare:43:42",
        "frontend:43:42",
        "prepare:43:42",
        "frontend:43:42",
        "package:43:42",
        "prepare:43:42",
        "frontend:43:42",
        "package:43:42",
        "frontend:44:43",
        "",
      ].join("\n"),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")(
  "interruption cannot confirm a number even when a stage handles SIGTERM with exit zero",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "lab-build-interrupt-"))
    try {
      expect(await Bun.spawn(["git", "init", "--quiet", directory]).exited).toBe(0)
      await writeFile(join(directory, ".git/lab-build-sequence"), "42\n")
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({
          scripts: {
            prebuild: "bun step.ts",
            "electron-vite": "bun step.ts",
            "package:debug": "bun step.ts",
          },
        }),
      )
      await writeFile(
        join(directory, "step.ts"),
        `
      import { writeFileSync } from "node:fs"
      process.on("SIGTERM", () => process.exit(0))
      writeFileSync("ready", String(process.pid))
      setInterval(() => {}, 1000)
    `,
      )
      await writeFile(
        join(directory, "runner.ts"),
        `
      import { buildKoma } from ${JSON.stringify(join(import.meta.dir, "build-koma.ts"))}
      await buildKoma(import.meta.dir, true)
    `,
      )
      const child = Bun.spawn([process.execPath, join(directory, "runner.ts")], { stdout: "ignore", stderr: "ignore" })
      try {
        const deadline = Date.now() + 5000
        while (!(await Bun.file(join(directory, "ready")).exists()) && Date.now() < deadline) await Bun.sleep(10)
        expect(await Bun.file(join(directory, "ready")).exists()).toBe(true)
        child.kill("SIGTERM")
        expect(await child.exited).not.toBe(0)
        expect(await readFile(join(directory, ".git/lab-build-sequence"), "utf8")).toBe("42\n")
        expect(await readdir(join(directory, ".git"))).not.toContain("lab-build-sequence.lock")
      } finally {
        child.kill()
        await child.exited
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
