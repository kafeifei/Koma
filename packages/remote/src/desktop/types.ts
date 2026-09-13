export type RemoteDevice = {
  id: string
  name: string
  online: boolean | null
  current: boolean
  connectable?: boolean
  connected?: boolean
}

export type RemoteCleanupResult = {
  state: RemoteAccessState
  results: { id: string; status: import("./remote-registrations").RemoteRemovalStatus }[]
}

export type RemoteAccessState = {
  configured: boolean
  account: { name: string; username: string } | null
  authorization: { userCode: string; verificationUri: string; expiresAt: number } | null
  enabled: boolean
  status: "disabled" | "connecting" | "online" | "offline"
  deviceName: string
  website: string | null
  devices: RemoteDevice[]
  devicesError?: boolean
  quota?: import("./remote-registrations").RemoteQuota | null
  error: "configuration" | "authentication" | "connection" | "capacity" | null
}

export type RemoteAccessPlatform = {
  getState(): Promise<RemoteAccessState>
  signIn(): Promise<RemoteAccessState>
  cancelSignIn(): Promise<RemoteAccessState>
  signOut(): Promise<RemoteAccessState>
  setEnabled(enabled: boolean): Promise<RemoteAccessState>
  rename(name: string): Promise<RemoteAccessState>
  refresh(): Promise<RemoteAccessState>
  connect(id: string): Promise<{ url: string; name: string }>
  remove(ids: string[]): Promise<RemoteCleanupResult>
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
