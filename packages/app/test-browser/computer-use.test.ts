import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createComputerUseController } from "../src/utils/computer-use-controller"
import type { ComputerUseState, ComputerUseAction } from "@opencode-ai/core/koma-computer-use-types"
import type { ServerConnection } from "../src/context/server"

const ready = (device: string, enabled = false): ComputerUseState => ({
  device,
  enabled,
  supported: true,
  installed: true,
  platform: "darwin",
  running: true,
  accessibility: true,
  screenRecording: true,
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup() {
  const requests: {
    url: string
    action: ComputerUseAction
    resolve: (value: ComputerUseState) => void
    reject: (error: Error) => void
  }[] = []
  let controller!: ReturnType<typeof createComputerUseController>
  let select!: (connection: ServerConnection.HttpBase) => void
  const dispose = createRoot((dispose) => {
    const [connection, setConnection] = createSignal<ServerConnection.HttpBase>({ url: "http://local.test" })
    select = setConnection
    controller = createComputerUseController({
      connection,
      active: () => true,
      request: (connection, action) =>
        new Promise((resolve, reject) => requests.push({ url: connection.url, action, resolve, reject })),
    })
    return dispose
  })
  return { controller, requests, select, dispose }
}

test("switching devices clears previous state and ignores late responses from the old device", async () => {
  const { controller, requests, select, dispose } = setup()
  try {
    await tick()
    requests[0]!.resolve(ready("Local Mac"))
    await tick()
    expect(controller.state()?.device).toBe("Local Mac")
    const stale = controller.refetch()
    select({ url: "http://remote.test" })
    await tick()
    expect(controller.state()).toBeUndefined()
    requests[2]!.resolve(ready("Remote Mac"))
    await tick()
    requests[1]!.resolve(ready("Local Mac", true))
    await stale
    expect(controller.state()?.device).toBe("Remote Mac")
    expect(controller.state()?.enabled).toBe(false)
  } finally {
    dispose()
  }
})

test("late status and failed actions cannot overwrite a newer toggle result", async () => {
  const { controller, requests, dispose } = setup()
  try {
    await tick()
    const action = controller.action({ action: "enable", enabled: true })
    requests[1]!.resolve(ready("Local Mac", true))
    await action
    requests[0]!.resolve(ready("Local Mac", false))
    await tick()
    expect(controller.state()?.enabled).toBe(true)
    const failed = controller.action({ action: "enable", enabled: false })
    requests[2]!.reject(new Error("Connection lost"))
    await failed
    expect(controller.state()?.enabled).toBe(true)
    expect(controller.error()).toBe("Connection lost")
    expect(controller.pending()).toBe(false)
  } finally {
    dispose()
  }
})
