/** Private parent/child IPC, never a renderer or network credential endpoint. */
export function createHostRPC(
  transport: {
    send(message: unknown): void
    onMessage(callback: (message: any) => void): void
    onClose(callback: () => void): void
  },
  handle: (method: string, params: any) => Promise<unknown>,
) {
  let sequence = 0
  let closed = false
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>()
  transport.onClose(() => {
    closed = true
    pending.forEach(({ reject }) => reject(new Error("Desktop host disconnected")))
    pending.clear()
  })
  transport.onMessage((message) => {
    if (typeof message?.id !== "number") return
    if (typeof message.method === "string") {
      void handle(message.method, message.params).then(
        (value) => {
          if (!closed) transport.send({ id: message.id, value: value ?? null })
        },
        () => {
          if (!closed) transport.send({ id: message.id, error: "Desktop host operation failed" })
        },
      )
      return
    }
    const result = pending.get(message.id)
    if (!result) return
    pending.delete(message.id)
    if (message.error) result.reject(new Error(message.error))
    else result.resolve(message.value)
  })
  return <T = any>(method: string, params?: unknown) =>
    new Promise<T>((resolve, reject) => {
      if (closed) return reject(new Error("Desktop host disconnected"))
      const id = ++sequence
      pending.set(id, { resolve, reject })
      try {
        transport.send({ id, method, params })
      } catch (error) {
        pending.delete(id)
        reject(error)
      }
    })
}
