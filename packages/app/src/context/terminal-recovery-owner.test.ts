import { describe, expect, test } from "bun:test"
import {
  createTerminalRecoveryOwner,
  dispatchTerminalFailure,
  type TerminalFailureSource,
} from "./terminal-recovery-owner"

type Candidate = {
  id: string
  title: string
}

function deferred<T>() {
  const result = {} as {
    promise: Promise<T>
    resolve: (value: T) => void
  }
  result.promise = new Promise((resolve) => {
    result.resolve = resolve
  })
  return result
}

function setup(ids = ["one"]) {
  const terminals = ids.map((id) => ({ id, title: id }))
  const created: string[] = []
  const discarded: string[] = []
  const pending: Array<ReturnType<typeof deferred<Candidate | undefined>>> = []
  const owner = createTerminalRecoveryOwner({
    exists: (id) => terminals.some((terminal) => terminal.id === id),
    create: async () => {
      created.push("create")
      const next = deferred<Candidate | undefined>()
      pending.push(next)
      return next.promise
    },
    replace: (id, candidate) => {
      const index = terminals.findIndex((terminal) => terminal.id === id)
      if (index === -1) return false
      terminals.splice(index, 1, candidate)
      return true
    },
    discard: async (id) => {
      discarded.push(id)
    },
  })

  return { terminals, created, discarded, pending, owner }
}

describe("terminal recovery failure policy", () => {
  test("does not recover initialization, ticket, or network failures", () => {
    const reported: TerminalFailureSource[] = []
    const recovered: TerminalFailureSource[] = []
    const sources = ["initialization", "ticket", "network"] as const

    for (const source of sources) {
      dispatchTerminalFailure({
        source,
        error: source,
        report: (error) => reported.push(error as TerminalFailureSource),
        recover: (error) => recovered.push(error as TerminalFailureSource),
      })
    }

    expect(reported).toEqual([...sources])
    expect(recovered).toEqual([])
  })

  test("recovers only a backend-confirmed missing terminal", () => {
    const reported: string[] = []
    const recovered: string[] = []
    dispatchTerminalFailure({
      source: "missing",
      error: "gone",
      report: (error) => reported.push(String(error)),
      recover: (error) => recovered.push(String(error)),
    })

    expect(reported).toEqual([])
    expect(recovered).toEqual(["gone"])
  })
})

describe("terminal recovery owner", () => {
  test("coalesces concurrent recovery and stays bounded until the replacement connects", async () => {
    const harness = setup()
    const first = harness.owner.recover("one")
    const concurrent = harness.owner.recover("one")
    expect(harness.created).toHaveLength(0)

    await Promise.resolve()
    expect(harness.created).toHaveLength(1)
    harness.pending[0].resolve({ id: "two", title: "one" })
    expect(await first).toBe("two")
    expect(await concurrent).toBe("two")
    expect(harness.terminals.map((terminal) => terminal.id)).toEqual(["two"])

    expect(await harness.owner.recover("two")).toBeUndefined()
    expect(harness.created).toHaveLength(1)

    harness.owner.connected("two")
    const next = harness.owner.recover("two")
    await Promise.resolve()
    expect(harness.created).toHaveLength(2)
    harness.pending[1].resolve({ id: "three", title: "one" })
    expect(await next).toBe("three")
  })

  test("replaces the current terminal position after a reorder", async () => {
    const harness = setup(["one", "other"])
    const recovery = harness.owner.recover("one")
    await Promise.resolve()
    harness.terminals.unshift(harness.terminals.splice(1, 1)[0])
    harness.pending[0].resolve({ id: "two", title: "one" })

    expect(await recovery).toBe("two")
    expect(harness.terminals.map((terminal) => terminal.id)).toEqual(["other", "two"])
    expect(harness.discarded).toEqual([])
  })

  test("discards only the late candidate after close", async () => {
    const harness = setup()
    const recovery = harness.owner.recover("one")
    await Promise.resolve()
    harness.owner.cancel("one")
    harness.terminals.splice(0)
    harness.pending[0].resolve({ id: "candidate", title: "one" })

    expect(await recovery).toBeUndefined()
    expect(harness.terminals).toEqual([])
    expect(harness.discarded).toEqual(["candidate"])
  })

  test("discards late candidates after clear and dispose", async () => {
    const cleared = setup()
    const clearRecovery = cleared.owner.recover("one")
    await Promise.resolve()
    cleared.owner.clear()
    cleared.terminals.splice(0)
    cleared.pending[0].resolve({ id: "after-clear", title: "one" })
    expect(await clearRecovery).toBeUndefined()
    expect(cleared.discarded).toEqual(["after-clear"])

    const disposed = setup()
    const disposeRecovery = disposed.owner.recover("one")
    await Promise.resolve()
    disposed.owner.dispose()
    disposed.terminals.splice(0)
    disposed.pending[0].resolve({ id: "after-dispose", title: "one" })
    expect(await disposeRecovery).toBeUndefined()
    expect(disposed.discarded).toEqual(["after-dispose"])
  })
})
