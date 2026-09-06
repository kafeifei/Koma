export type BuildInfo = {
  id: string
  version: string
  sequence?: number
  channel: string
  commit?: string
  dirty: boolean
  builtAt: string
}
