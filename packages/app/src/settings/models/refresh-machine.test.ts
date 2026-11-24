import { expect, test } from "bun:test"
import { createRefreshState, refreshClaimed, transitionRefresh, type RefreshEvent } from "./refresh-machine"

const run = (events: readonly RefreshEvent[]) => events.reduce(transitionRefresh, createRefreshState())

test.each([
  { name: "a request claims the refresh", events: [{ type: "requested", attempt: 1 }], claimed: 1 },
  {
    name: "a second request while one runs is ignored",
    events: [
      { type: "requested", attempt: 1 },
      { type: "requested", attempt: 2 },
    ],
    claimed: 1,
  },
  {
    name: "a stale result does not end the current request",
    events: [
      { type: "requested", attempt: 1 },
      { type: "settled", attempt: 1 },
      { type: "requested", attempt: 2 },
      { type: "settled", attempt: 1 },
    ],
    claimed: 2,
  },
  {
    name: "its own result ends the request",
    events: [
      { type: "requested", attempt: 1 },
      { type: "settled", attempt: 1 },
    ],
    claimed: undefined,
  },
] as const)("$name", ({ events, claimed }) => {
  const state = run(events)

  expect(state.status).toBe(claimed === undefined ? "idle" : "refreshing")
  expect([1, 2].filter((attempt) => refreshClaimed(state, attempt))).toEqual(claimed === undefined ? [] : [claimed])
})
