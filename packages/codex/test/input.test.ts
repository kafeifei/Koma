import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, test } from "bun:test"
import { codexInput, prepareInput, threadSettings, turnSettings } from "../src/input.js"

describe("Codex input", () => {
  test("freezes local image bytes before durable admission", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "opencode-codex-input-"))
    const path = resolve(directory, "image.png")
    await writeFile(path, "first-image")
    const prepared = await prepareInput({
      prompt: {
        text: "inspect",
        files: [{ uri: pathToFileURL(path).href, mime: "image/png", name: "image.png" }],
      },
      settings: {},
    })
    await writeFile(path, "changed-after-admission")

    expect(prepared.prompt.files?.[0]?.uri).toBe(
      `data:image/png;base64,${Buffer.from("first-image").toString("base64")}`,
    )
    expect(codexInput(prepared)).toEqual([
      { type: "text", text: "inspect", text_elements: [] },
      { type: "image", url: `data:image/png;base64,${Buffer.from("first-image").toString("base64")}` },
    ])
  })

  test("rejects unresolved browser attachments", async () => {
    await expect(
      prepareInput({
        prompt: { text: "inspect", files: [{ uri: "blob:temporary", mime: "image/png" }] },
        settings: {},
      }),
    ).rejects.toThrow("uploaded before submitting")
  })

  test("does not widen permissions when no explicit permission was selected", () => {
    expect(threadSettings({ model: "gpt-test" })).toEqual({ model: "gpt-test" })
    expect(turnSettings({ model: "gpt-test", effort: "high" }, "/workspace")).toEqual({
      model: "gpt-test",
      effort: "high",
      approvalPolicy: undefined,
      approvalsReviewer: undefined,
      sandboxPolicy: undefined,
    })
  })

  test("maps explicit permission choices to one native policy pair", () => {
    expect(threadSettings({ permission: "readOnly" })).toEqual({
      model: undefined,
      sandbox: "read-only",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    })
    expect(turnSettings({ permission: "workspace" }, "/workspace")).toEqual({
      model: undefined,
      effort: undefined,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/workspace"],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    })
    expect(turnSettings({ permission: "full" }, "/workspace")).toEqual({
      model: undefined,
      effort: undefined,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    })
  })
})
