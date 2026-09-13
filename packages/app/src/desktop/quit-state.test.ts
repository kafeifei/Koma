import { expect, test } from "bun:test"
import { createDesktopQuitState, createShutdownController } from "./shutdown-controller"

test("cancelling quit keeps terminals active; confirming stops them before the backend", async () => {
  const state = createDesktopQuitState()
  const confirmation = Promise.withResolvers<boolean>()
  const calls: string[] = []
  let confirmed = false
  state.subscribe((quitting) => calls.push(quitting ? "disconnect terminals" : "connect terminals"))
  const controller = createShutdownController({
    confirm: () => (confirmed ? Promise.resolve(true) : confirmation.promise),
    setQuitting: state.setQuitting,
    stop: async () => {
      calls.push("stop backend")
    },
    quit: () => {
      calls.push("quit")
    },
    schedule: (callback) => callback(),
    log: () => {},
    warn: () => {},
  })
  const pending = controller.requestQuit()
  expect(calls).toEqual(["connect terminals"])
  confirmation.resolve(false)
  expect(await pending).toBe(false)
  expect(calls).toEqual(["connect terminals"])
  confirmed = true
  expect(await controller.requestQuit()).toBe(true)
  expect(calls).toEqual(["connect terminals", "disconnect terminals", "stop backend", "quit"])
})

test("late terminals see shutdown and subscribers resume if native quit fails", async () => {
  const state = createDesktopQuitState()
  const values: boolean[] = []
  let unsubscribe: () => void = () => {}
  const controller = createShutdownController({
    setQuitting: state.setQuitting,
    stop: async () => {
      unsubscribe = state.subscribe((value) => values.push(value))
    },
    quit: () => {
      throw new Error("native quit failed")
    },
    schedule: (callback) => callback(),
    log: () => {},
    warn: () => {},
  })
  await expect(controller.requestQuit()).rejects.toThrow("native quit failed")
  expect(values).toEqual([true, false])
  unsubscribe()
  state.setQuitting(true)
  expect(values).toEqual([true, false])
})
