import { createInterface } from "node:readline"

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

lines.on("line", (line) => {
  const message = JSON.parse(line) as Record<string, unknown>
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        userAgent: "fixture/0",
        codexHome: "/fixture/home",
        platformFamily: "unix",
        platformOs: "fixture",
      },
    })
    return
  }
  if (message.method === "initialized") {
    send({ method: "fixture/notification", params: { ready: true } })
    send({ id: "server-request", method: "fixture/request", params: { question: 42 } })
    return
  }
  if (message.id === "server-request") {
    send({ method: "fixture/requestResult", params: message.result ?? message.error })
    return
  }
  if (message.method === "thread/read") {
    const params = message.params as Record<string, unknown>
    if (params.threadId === "exit") {
      process.exit(17)
    }
    send({ id: message.id, result: { thread: { id: params.threadId } } })
  }
})

function send(message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
