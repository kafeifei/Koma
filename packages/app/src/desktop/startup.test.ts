import { describe, expect, test } from "bun:test"
import { startupState } from "./startup"

describe("desktop startup readiness", () => {
  test("waits for a lazy page to mount even when the backend is ready", () => {
    expect(startupState([{ stage: "backend", state: { ready: true }, page: false }]).ready).toBe(false)
  })

  test("waits for current-page data, not just a mounted page", () => {
    const state = startupState([
      { stage: "page", state: { ready: true }, page: true },
      { stage: "models", state: { ready: false }, page: false },
    ])
    expect(state.ready).toBe(false)
    expect(state.stage).toBe("models")
  })

  test("an empty but successfully loaded catalog is usable", () => {
    expect(
      startupState([
        { stage: "page", state: { ready: true }, page: true },
        { stage: "models", state: { ready: true }, page: false },
      ]).ready,
    ).toBe(true)
  })

  test("settled requests with an error never count as ready", () => {
    const error = new Error("Models unavailable")
    expect(
      startupState([
        { stage: "page", state: { ready: true }, page: true },
        { stage: "models", state: { ready: true, error }, page: false },
      ]),
    ).toMatchObject({ ready: false, stage: "models", error })
  })
})
