export type RemoteDevice = {
  id: string
  name: string
  online: boolean | null
  current: boolean
}

export type RemoteAccessState = {
  /** Native client identity and legacy listener ownership, independent of account connectivity. */
  clientID?: string
  connections?: { id: string; clientID: string; url: string; current: boolean }[]
  configured: boolean
  account: { name: string; username: string } | null
  authorization: { userCode: string; verificationUri: string; expiresAt: number } | null
  enabled: boolean
  status: "disabled" | "connecting" | "online" | "offline"
  deviceName: string
  website: string | null
  devices: RemoteDevice[]
  error: "configuration" | "authentication" | "connection" | null
}

export type RemoteAccessPlatform = {
  getState(): Promise<RemoteAccessState>
  signIn(): Promise<RemoteAccessState>
  cancelSignIn(): Promise<RemoteAccessState>
  signOut(): Promise<RemoteAccessState>
  setEnabled(enabled: boolean): Promise<RemoteAccessState>
  rename(name: string): Promise<RemoteAccessState>
  refresh(): Promise<RemoteAccessState>
  connect(id: string): Promise<{ url: string; name: string; remote?: { id: string; clientID: string } }>
  disconnect(id: string): Promise<void>
  subscribe(callback: (state: RemoteAccessState) => void): () => void
}
export type WebEntryState = {
  enabled: boolean
  url: string | null
  error: boolean
}

export type WebEntryPlatform = {
  getState(): Promise<WebEntryState>
  setEnabled(enabled: boolean): Promise<WebEntryState>
  subscribe(callback: (state: WebEntryState) => void): () => void
}
