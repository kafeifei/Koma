import { expect, test } from "bun:test"
import type { MessageBoxOptions } from "electron"
import { confirmBackendShutdown } from "./shutdown-confirmation"

const backend = { url: "http://127.0.0.1:1234", username: "test", password: "test" }

test("a remote-only desktop does not query or prompt about a local backend", async () => {
  expect(
    await confirmBackendShutdown({
      backend: async () => undefined,
      fetch: async () => {
        throw new Error("must not query a remote backend")
      },
      showDialog: async () => {
        throw new Error("must not prompt")
      },
      warn: () => {
        throw new Error("unexpected warning")
      },
    }),
  ).toBe(true)
})

test("verified idle backend can quit without a dialog", async () => {
  const requests: string[] = []
  expect(
    await confirmBackendShutdown({
      backend: async () => backend,
      fetch: async (url, options) => {
        requests.push(String(url))
        expect(options?.signal).toBeInstanceOf(AbortSignal)
        expect(new Headers(options?.headers).get("Authorization")).toBe("Basic dGVzdDp0ZXN0")
        return Response.json({ active: false })
      },
      showDialog: async () => {
        throw new Error("must not prompt")
      },
      warn: () => {
        throw new Error("unexpected warning")
      },
    }),
  ).toBe(true)
  expect(requests).toEqual(["http://127.0.0.1:1234/lab/shutdown-state"])
})

test.each([0, 1])("active tasks require an explicit stop choice (%s)", async (response) => {
  const dialogs: MessageBoxOptions[] = []
  expect(
    await confirmBackendShutdown({
      backend: async () => backend,
      fetch: async () => Response.json({ active: true }),
      showDialog: async (options) => {
        dialogs.push(options)
        return { response }
      },
      warn: () => {
        throw new Error("unexpected warning")
      },
    }),
  ).toBe(response === 1)
  expect(dialogs).toHaveLength(1)
  expect(dialogs[0]).toMatchObject({
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    buttons: ["Cancel", "Stop tasks and quit"],
  })
})

test.each([new Response(null, { status: 404 }), Response.json({ active: "false" })])(
  "unavailable or invalid status is never treated as idle",
  async (response) => {
    const warnings: unknown[] = []
    const dialogs: MessageBoxOptions[] = []
    expect(
      await confirmBackendShutdown({
        backend: async () => backend,
        fetch: async () => response,
        showDialog: async (options) => {
          dialogs.push(options)
          return { response: 0 }
        },
        warn: (error) => warnings.push(error),
      }),
    ).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(dialogs[0]).toMatchObject({
      defaultId: 0,
      cancelId: 0,
      buttons: ["Cancel", "Quit anyway"],
    })
  },
)

test("a stalled backend startup has a bounded check and an explicit quit choice", async () => {
  const warnings: unknown[] = []
  const dialogs: MessageBoxOptions[] = []
  expect(
    await confirmBackendShutdown({
      backend: () => new Promise(() => undefined),
      fetch: async () => {
        throw new Error("must not fetch before startup")
      },
      showDialog: async (options) => {
        dialogs.push(options)
        return { response: 1 }
      },
      warn: (error) => warnings.push(error),
      timeoutMs: 1,
    }),
  ).toBe(true)
  expect(warnings).toHaveLength(1)
  expect(dialogs[0].buttons).toEqual(["Cancel", "Quit anyway"])
})

test("waiting at the dialog does not expire a successful status check", async () => {
  const answer = Promise.withResolvers<{ response: number }>()
  const opened = Promise.withResolvers<void>()
  const warnings: unknown[] = []
  const pending = confirmBackendShutdown({
    backend: async () => backend,
    fetch: async () => Response.json({ active: true }),
    showDialog: () => {
      opened.resolve()
      return answer.promise
    },
    warn: (error) => warnings.push(error),
    timeoutMs: 1,
  })
  await opened.promise
  await Bun.sleep(10)
  expect(warnings).toHaveLength(0)
  answer.resolve({ response: 0 })
  expect(await pending).toBe(false)
})
