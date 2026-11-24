// Koma: the lifecycle of the Models page's "Refresh models" request. One request runs at a time; a result is taken
// only from the request that is current.
export type RefreshState =
  | { readonly status: "idle" }
  | { readonly status: "refreshing"; readonly attempt: number }

export type RefreshEvent =
  | { readonly type: "requested"; readonly attempt: number }
  | { readonly type: "settled"; readonly attempt: number }

const idle: RefreshState = Object.freeze({ status: "idle" })

export function createRefreshState(): RefreshState {
  return idle
}

export function transitionRefresh(state: RefreshState, event: RefreshEvent): RefreshState {
  if (event.type === "requested") return state.status === "idle" ? { status: "refreshing", attempt: event.attempt } : state

  return state.status === "refreshing" && state.attempt === event.attempt ? idle : state
}

/** Whether the request with this attempt id is the one in flight. */
export function refreshClaimed(state: RefreshState, attempt: number) {
  return state.status === "refreshing" && state.attempt === attempt
}
