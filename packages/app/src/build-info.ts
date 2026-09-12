export type BuildInfo = {
  id: string
  version: string
  sequence?: number
  channel: string
  release?: boolean
  commit?: string
  dirty: boolean
  builtAt: string
}

export function desktopDebugTools(build: Pick<BuildInfo, "release" | "channel">) {
  return !build.release && ["dev", "lab"].includes(build.channel)
}
