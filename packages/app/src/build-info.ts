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
