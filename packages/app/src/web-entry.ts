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
