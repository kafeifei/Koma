import { createEffect, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { Persist, persisted } from "@/utils/persist"

const workspaceBarEnabled = import.meta.env.VITE_OPENCODE_CHANNEL !== "prod"

export function resolveNewSessionIsolation(input: {
  visible: boolean
  preferred: boolean
  hasHead: boolean
  loading: boolean
  failed: boolean
}) {
  if (!input.visible) return false
  if (input.loading || input.failed) return input.preferred
  return input.hasHead && input.preferred
}

export function resolveNewSessionWorktree(isolated: boolean) {
  return isolated ? "create" : "main"
}

export function resolveNewSessionBranch(input: { isolated: boolean; current?: string; base?: string }) {
  return input.isolated ? input.base : input.current
}

export function resolveNewSessionBaseBranch(input: { selected?: string; fallback?: string }) {
  return input.selected ?? input.fallback
}

export function createNewSessionWorkspaceController() {
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const [preference, setPreference, , preferenceReady] = persisted(
    Persist.global("new-session.worktree"),
    createStore({ isolated: true }),
  )
  const [state, setState] = createStore<{ projectRoot?: string; baseBranch?: string }>({})
  const visible = createMemo(() => workspaceBarEnabled && sync().project?.vcs === "git")
  const projectRoot = createMemo(() => sync().project?.worktree ?? sdk().directory)
  const [options, optionsControl] = createResource(
    () => (visible() ? sdk().directory : undefined),
    async (directory) => {
      if (!directory) return
      try {
        const data = (await sdk().client.worktree.options({ directory })).data
        return { ...data, failed: false }
      } catch {
        return { hasHead: false, branches: [], failed: true }
      }
    },
  )
  const optionsFailed = createMemo(() => options()?.failed === true)
  const hasHead = createMemo(() => options()?.hasHead === true)
  const isolated = createMemo(() =>
    resolveNewSessionIsolation({
      visible: visible(),
      preferred: preference.isolated,
      hasHead: hasHead(),
      loading: options.loading,
      failed: optionsFailed(),
    }),
  )
  const worktreeReady = createMemo(
    () => preferenceReady() && (!isolated() || (!options.loading && !optionsFailed() && hasHead())),
  )
  const value = createMemo(() => resolveNewSessionWorktree(isolated()))

  createEffect(() => {
    const root = projectRoot()
    if (state.projectRoot === root) return
    setState({ projectRoot: root, baseBranch: undefined })
  })

  const currentBranch = createMemo(() => options()?.currentBranch ?? serverSync().child(sdk().directory)[0].vcs?.branch)
  const defaultBranch = createMemo(() => options()?.defaultBranch ?? currentBranch() ?? options()?.branches?.[0])
  const selectedBaseBranch = createMemo(() =>
    resolveNewSessionBaseBranch({
      selected: state.projectRoot === projectRoot() ? state.baseBranch : undefined,
      fallback: defaultBranch(),
    }),
  )
  const branch = createMemo(() =>
    resolveNewSessionBranch({ isolated: isolated(), current: currentBranch(), base: selectedBaseBranch() }),
  )

  return {
    selection: {
      value,
      isolated,
      reset: () => setState({ baseBranch: undefined }),
      setIsolated: (value: boolean) => setPreference("isolated", value),
      disabled: createMemo(
        () =>
          !preferenceReady() || options.loading || (!hasHead() && !optionsFailed()) || (optionsFailed() && !isolated()),
      ),
      ready: worktreeReady,
      loading: () => options.loading,
      failed: optionsFailed,
      retry: () => void optionsControl.refetch(),
      useLocal: () => setPreference("isolated", false),
      setBaseBranch: (baseBranch: string) => setState({ projectRoot: projectRoot(), baseBranch }),
    },
    project: {
      root: projectRoot,
      git: () => sync().project?.vcs === "git",
      branches: () => options()?.branches ?? [],
    },
    bar: {
      visible,
      branch,
      currentBranch,
      baseBranch: selectedBaseBranch,
    },
  }
}

export type NewSessionWorkspaceController = ReturnType<typeof createNewSessionWorkspaceController>
