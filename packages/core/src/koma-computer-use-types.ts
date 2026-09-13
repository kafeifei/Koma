export const COMPUTER_USE_SERVER = "koma-computer-use"

export type ComputerUseAction =
  | { action: "status" | "install" | "start" | "grant" }
  | { action: "enable"; enabled: boolean }

export type ComputerUseState = {
  supported: boolean
  device: string
  platform: string
  enabled: boolean
  installed: boolean
  version?: string
  running: boolean
  accessibility: boolean | null
  screenRecording: boolean | null
  busy?: "install" | "grant" | "start"
  error?: string
}

export function computerUseStatus(state: ComputerUseState) {
  if (!state.supported) return "unsupported"
  if (state.busy) return "busy"
  if (state.error) return "error"
  if (!state.installed) return "notInstalled"
  if (!state.running) return "notRunning"
  if (state.accessibility !== true || state.screenRecording !== true) return "permissions"
  return state.enabled ? "ready" : "disabled"
}
