import { expect, test } from "bun:test"
import { createShutdownController } from "./shutdown-controller"

test("defers the admitted quit until after async shutdown", async () => {
  const calls: string[] = []
  const scheduled: (() => void)[] = []
  const stop = Promise.withResolvers<void>()
  const controller = createShutdownController({
    stop: () => {
      calls.push("stop")
      return stop.promise
    },
    quit: () => calls.push("quit"),
    setQuitting: () => calls.push("mark"),
    log: (message) => calls.push(message),
    warn: (message) => calls.push(message),
    schedule: (callback) => scheduled.push(callback),
  })
  const first = {
    prevented: false,
    preventDefault() {
      this.prevented = true
    },
  }
  const repeated = {
    prevented: false,
    preventDefault() {
      this.prevented = true
    },
  }

  controller.beforeQuit(first)
  controller.beforeQuit(repeated)
  expect(first.prevented).toBe(true)
  expect(repeated.prevented).toBe(true)
  expect(calls.filter((call) => call === "stop")).toHaveLength(1)
  expect(controller.isQuitting()).toBe(true)

  stop.resolve()
  await stop.promise
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(controller.didStop()).toBe(true)
  expect(scheduled).toHaveLength(1)
  expect(calls).not.toContain("quit")

  scheduled[0]()
  const admitted = {
    prevented: false,
    preventDefault() {
      this.prevented = true
    },
  }
  controller.beforeQuit(admitted)
  expect(admitted.prevented).toBe(false)
  expect(calls).toContain("runtime quit admitted")
})

test("allows quit after a bounded shutdown timeout without marking the runtime stopped", async () => {
  const calls: string[] = []
  const scheduled: (() => void)[] = []
  const controller = createShutdownController({
    stop: () => new Promise(() => undefined),
    quit: () => calls.push("quit"),
    setQuitting: () => undefined,
    log: (message) => calls.push(message),
    warn: (message) => calls.push(message),
    timeoutMs: 1,
    schedule: (callback) => scheduled.push(callback),
  })

  controller.beforeQuit({ preventDefault() {} })
  await Bun.sleep(10)
  expect(controller.didStop()).toBe(false)
  expect(calls).toContain("runtime shutdown timed out; preserving its resource snapshot")
  expect(scheduled).toHaveLength(1)

  scheduled[0]()
  expect(calls).toContain("quit")
})

test("marks relaunch shutdowns so activation cannot restore a window", () => {
  let marked = 0
  const controller = createShutdownController({
    stop: () => Promise.resolve(),
    quit: () => undefined,
    setQuitting: () => marked++,
    log: () => undefined,
    warn: () => undefined,
  })

  controller.markQuitting()
  expect(controller.isQuitting()).toBe(true)
  expect(marked).toBe(1)
})
