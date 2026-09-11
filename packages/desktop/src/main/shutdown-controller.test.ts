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

test("marks relaunch shutdowns so activation cannot restore a window", async () => {
  let marked = 0
  const controller = createShutdownController({
    stop: () => Promise.resolve(),
    quit: () => undefined,
    setQuitting: () => marked++,
    log: () => undefined,
    warn: () => undefined,
  })

  await controller.requestQuit(() => undefined)
  expect(controller.isQuitting()).toBe(true)
  expect(marked).toBe(1)
})

test("cancelling a shared confirmation preserves the app and permits a later quit", async () => {
  const confirmation = Promise.withResolvers<boolean>()
  let confirmations = 0
  let stops = 0
  let marks = 0
  const actions: string[] = []
  const scheduled: (() => void)[] = []
  const controller = createShutdownController({
    confirm: () => (++confirmations === 1 ? confirmation.promise : Promise.resolve(true)),
    stop: async () => {
      stops++
    },
    quit: () => actions.push("quit"),
    setQuitting: () => {
      marks++
    },
    log: () => undefined,
    warn: () => undefined,
    schedule: (callback) => scheduled.push(callback),
  })
  const first = controller.requestQuit(() => actions.push("relaunch"))
  const repeated = controller.requestQuit()
  expect(repeated).toBe(first)
  controller.beforeQuit({ preventDefault() {} })
  expect(confirmations).toBe(1)
  expect(stops).toBe(0)
  expect(marks).toBe(0)
  expect(controller.isQuitting()).toBe(false)
  confirmation.resolve(false)
  expect(await first).toBe(false)
  expect(stops).toBe(0)
  expect(scheduled).toHaveLength(0)
  const next = controller.requestQuit()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(confirmations).toBe(2)
  expect(stops).toBe(1)
  expect(marks).toBe(1)
  scheduled[0]()
  expect(await next).toBe(true)
  expect(actions).toEqual(["quit"])
})

test("confirmation failures never stop the backend or mark windows as quitting", async () => {
  let stopped = false
  const controller = createShutdownController({
    confirm: async () => {
      throw new Error("dialog unavailable")
    },
    stop: async () => {
      stopped = true
    },
    quit: () => {
      throw new Error("must stay open")
    },
    setQuitting: () => {
      throw new Error("must not mark windows")
    },
    log: () => undefined,
    warn: () => undefined,
  })
  expect(await controller.requestQuit()).toBe(false)
  expect(stopped).toBe(false)
  expect(controller.isQuitting()).toBe(false)
})

test("relaunch owns the final action while confirmation is pending", async () => {
  const confirmation = Promise.withResolvers<boolean>()
  const actions: string[] = []
  const scheduled: (() => void)[] = []
  const controller = createShutdownController({
    confirm: () => confirmation.promise,
    stop: async () => {
      actions.push("stop")
    },
    quit: () => actions.push("quit"),
    setQuitting: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    schedule: (callback) => scheduled.push(callback),
  })
  const relaunch = controller.requestQuit(() => actions.push("relaunch"))
  controller.beforeQuit({ preventDefault() {} })
  confirmation.resolve(true)
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(actions).toEqual(["stop"])
  expect(scheduled).toHaveLength(1)
  scheduled[0]()
  expect(await relaunch).toBe(true)
  expect(actions).toEqual(["stop", "relaunch"])
})

test("failed scheduled installation rejects its caller and permits a new quit", async () => {
  const scheduled: (() => void)[] = []
  const marked: boolean[] = []
  const warnings: unknown[] = []
  const controller = createShutdownController({
    stop: async () => undefined,
    quit: () => undefined,
    setQuitting: (value) => marked.push(value),
    log: () => undefined,
    warn: (_, error) => warnings.push(error),
    schedule: (callback) => scheduled.push(callback),
  })
  const failed = controller.requestQuit(() => {
    throw new Error("installer failed")
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(() => scheduled[0]()).not.toThrow()
  await expect(failed).rejects.toThrow("installer failed")
  expect(marked).toEqual([true, false])
  expect(warnings).toHaveLength(1)
  expect(controller.isQuitting()).toBe(false)
  const retry = controller.requestQuit()
  await new Promise<void>((resolve) => setImmediate(resolve))
  scheduled[1]()
  expect(await retry).toBe(true)
})

test("termination bypasses a pending dialog without stopping twice when it resolves", async () => {
  const confirmation = Promise.withResolvers<boolean>()
  let stops = 0
  const scheduled: (() => void)[] = []
  const controller = createShutdownController({
    confirm: () => confirmation.promise,
    stop: async () => {
      stops++
    },
    quit: () => undefined,
    setQuitting: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    schedule: (callback) => scheduled.push(callback),
  })
  const pending = controller.requestQuit()
  controller.forceQuit()
  controller.forceQuit()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(stops).toBe(1)
  expect(scheduled).toHaveLength(1)
  confirmation.resolve(false)
  await pending
  expect(stops).toBe(1)
  expect(scheduled).toHaveLength(1)
})

test("a failed termination action does not suppress the next ordinary quit", async () => {
  const scheduled: (() => void)[] = []
  let attempts = 0
  const controller = createShutdownController({
    stop: async () => undefined,
    quit: () => {
      if (++attempts === 1) throw new Error("native quit failed")
    },
    setQuitting: () => undefined,
    log: () => undefined,
    warn: () => undefined,
    schedule: (callback) => scheduled.push(callback),
  })
  controller.forceQuit()
  await new Promise<void>((resolve) => setImmediate(resolve))
  scheduled[0]()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(controller.isQuitting()).toBe(false)
  const retry = controller.requestQuit()
  await new Promise<void>((resolve) => setImmediate(resolve))
  expect(scheduled).toHaveLength(2)
  scheduled[1]()
  expect(await retry).toBe(true)
})
