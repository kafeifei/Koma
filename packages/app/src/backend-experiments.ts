export type BackendExperimentsState = {
  backgroundSubagents: boolean
  runningBackgroundSubagents: boolean | null
}

export type BackendExperimentsPlatform = {
  getState(): Promise<BackendExperimentsState>
  setBackgroundSubagents(enabled: boolean): Promise<BackendExperimentsState>
}
