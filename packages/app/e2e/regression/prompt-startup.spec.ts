import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { fixture } from "../performance/timeline/session-timeline-stress.fixture"

const directory = "C:/OpenCode/PromptStartup"
const draftID = `input:${base64Encode(JSON.stringify(["local", directory]))}`

for (const kind of ["draft", "session"] as const) {
  test(`does not accept ${kind} input before its saved draft is loaded`, async ({ page }) => {
    await mockOpenCodeServer(page, {
      directory,
      project: { id: "prompt-startup", worktree: directory, vcs: "git", time: {}, sandboxes: [] },
      provider: fixture.provider,
      sessions: [
        {
          id: "ses-startup",
          projectID: "prompt-startup",
          directory,
          title: "Startup conversation",
          version: "dev",
          time: { created: 1, updated: 1 },
        },
      ],
      pageMessages: () => ({ items: [] }),
    })
    await page.addInitScript(
      ({ directory, draftID, server, kind }) => {
        localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
        localStorage.setItem(
          "opencode.window.browser.dat:tabs",
          JSON.stringify([
            kind === "draft"
              ? { type: "draft", draftID, server, directory }
              : { type: "session", server, sessionId: "ses-startup" },
          ]),
        )
        const request = indexedDB.open("opencode-drafts", 1)
        request.onupgradeneeded = () => {
          request.result.createObjectStore("documents")
          request.result.createObjectStore("blobs")
        }
        request.onsuccess = () => {
          const database = request.result
          const transaction = database.transaction("documents", "readwrite")
          let released = false
          window.addEventListener("release-draft-storage", () => (released = true), { once: true })
          // Hold a real IndexedDB transaction until the test releases startup I/O.
          const hold = () => {
            if (released) return
            transaction.objectStore("documents").get("startup-barrier").onsuccess = hold
          }
          hold()
          document.documentElement.dataset.draftStorage = "blocked"
          transaction.oncomplete = () => {
            document.documentElement.dataset.draftStorage = "ready"
            database.close()
          }
        }
      },
      { directory, draftID, kind, server: `http://127.0.0.1:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}` },
    )
    await page.goto(
      kind === "draft"
        ? `/new-session?draftId=${encodeURIComponent(draftID)}`
        : `/${base64Encode(directory)}/session/ses-startup`,
    )
    await expect(page.locator("html")).toHaveAttribute("data-draft-storage", "blocked")
    await expect(page.locator('[data-component="task-sidebar"]')).toBeVisible()
    const editor = page.locator('[data-component="prompt-input-v2"] [data-component="prompt-input"]')
    await expect(page.locator('[data-component="prompt-input-v2"] [contenteditable="true"]')).toHaveCount(0)

    await page.evaluate(() => window.dispatchEvent(new Event("release-draft-storage")))
    await expect(editor).toBeEditable()
    await expect(editor).toBeEmpty()
    await editor.click()
    await expect(editor).toBeFocused()

    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Input.imeSetComposition", { text: "n", selectionStart: 0, selectionEnd: 1 })
    await expect(editor).toHaveText("n")
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
    await cdp.send("Input.imeSetComposition", { text: "ni", selectionStart: 0, selectionEnd: 2 })
    await expect(editor).toHaveText("ni")
    await cdp.send("Input.insertText", { text: "你" })
    await expect(editor).toHaveText("你")
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
    await cdp.detach()
  })
}
