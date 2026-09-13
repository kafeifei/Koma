import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js"
import type { ComputerUseAction, ComputerUseState } from "@opencode-ai/core/koma-computer-use-types"
import type { ServerConnection } from "@/context/server"

export function createComputerUseController(input: {
  connection: Accessor<ServerConnection.HttpBase | undefined>
  active: Accessor<boolean>
  request: (connection: ServerConnection.HttpBase, action: ComputerUseAction) => Promise<ComputerUseState>
}) {
  const [state, setState] = createSignal<ComputerUseState>()
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let generation = 0
  let readSequence = 0
  let disposed = false
  let reading = false
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

  const refetch = async () => {
    const connection = input.connection()
    if (!connection || !input.active() || pending()) return
    const epoch = generation
    const sequence = ++readSequence
    reading = true
    try {
      const value = await input.request(connection, { action: "status" })
      if (!disposed && epoch === generation && sequence === readSequence) {
        setState(value)
        setError(undefined)
      }
    } catch (error) {
      if (!disposed && epoch === generation && sequence === readSequence) {
        setState(undefined)
        setError(message(error))
      }
    } finally {
      if (sequence === readSequence) reading = false
    }
  }

  createEffect(() => {
    const connection = input.connection()
    const active = input.active()
    generation++
    readSequence++
    reading = false
    setState(undefined)
    setError(undefined)
    setPending(false)
    if (!connection || !active) return
    untrack(() => void refetch())
    const timer = setInterval(() => {
      if (!reading && !pending()) void refetch()
    }, 2500)
    const focus = () => {
      if (!reading && !pending()) void refetch()
    }
    window.addEventListener("focus", focus)
    onCleanup(() => {
      clearInterval(timer)
      window.removeEventListener("focus", focus)
    })
  })
  onCleanup(() => {
    disposed = true
    generation++
    readSequence++
  })

  const action = async (request: ComputerUseAction) => {
    const connection = input.connection()
    if (!connection || !input.active() || pending()) return
    const epoch = generation
    readSequence++ // An older status response must not overwrite a completed mutation.
    reading = false
    setPending(true)
    setError(undefined)
    try {
      const value = await input.request(connection, request)
      if (!disposed && epoch === generation) setState(value)
    } catch (error) {
      if (!disposed && epoch === generation) setError(message(error))
    } finally {
      if (!disposed && epoch === generation) setPending(false)
    }
  }
  return { state, pending, error, action, refetch }
}
