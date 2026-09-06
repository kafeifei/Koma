import { createEffect, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"

const workspaceBarEnabled = import.meta.env.VITE_OPENCODE_CHANNEL !== "prod"

export function resolveNewSessionWorktree(input: {
  enabled: boolean
  selected?: string
  directory: string
  projectWorktree?: string
}) {
  if (!input.enabled) return "main"
  if (input.selected) return input.selected
  if (input.projectWorktree && input.directory !== input.projectWorktree) return input.directory
  return "create"
}

export function normalizeNewSessionWorktree(value: string, directory: string, projectWorktree?: string) {
  if (value === "main" && projectWorktree !== directory) return projectWorktree
  return value
}

export function resolveNewSessionBranch(input: {
  worktree: string
  local?: string
  worktreeBranch: (worktree: string) => string | undefined
}) {
  if (input.worktree === "main" || input.worktree === "create") return input.local
  return input.worktreeBranch(input.worktree) ?? input.local
}

export function resolveNewSessionBaseBranch(input: { worktree: string; selected?: string; fallback?: string }) {
  if (input.worktree !== "create") return undefined
  return input.selected ?? input.fallback
}

export function createNewSessionWorkspaceController() {
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const [state, setState] = createStore<{ projectRoot?: string; worktree?: string; baseBranch?: string }>({})
  const visible = createMemo(() => workspaceBarEnabled && sync().project?.vcs === "git")
  const projectRoot = createMemo(() => sync().project?.worktree ?? sdk().directory)
  const [options, optionsControl] = createResource(
    () => (visible() ? projectRoot() : undefined),
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
  const worktreeEnabled = createMemo(() => visible() && hasHead())
  const worktreeReady = createMemo(() => {
    if (!visible()) return true
    if (state.worktree === projectRoot() || state.worktree === "main") return true
    return !options.loading && !optionsFailed()
  })
  const value = createMemo(() =>
    resolveNewSessionWorktree({
      enabled: worktreeEnabled(),
      selected: state.worktree,
      directory: sdk().directory,
      projectWorktree: sync().project?.worktree,
    }),
  )
  createEffect(() => {
    const root = projectRoot()
    if (state.projectRoot === root) return
    setState({ projectRoot: root, worktree: undefined, baseBranch: undefined })
  })
  const localBranch = createMemo(() => serverSync().child(projectRoot())[0].vcs?.branch)
  const defaultBranch = createMemo(() => options()?.defaultBranch ?? localBranch())
  const selectedBaseBranch = createMemo(() =>
    resolveNewSessionBaseBranch({ worktree: value(), selected: state.baseBranch, fallback: defaultBranch() }),
  )
  const branch = createMemo(() =>
    resolveNewSessionBranch({
      worktree: value(),
      local: value() === "create" ? selectedBaseBranch() : localBranch(),
      worktreeBranch: (worktree) => serverSync().child(worktree)[0].vcs?.branch,
    }),
  )

  return {
    selection: {
      value,
      reset: () => setState({ worktree: undefined }),
      set: (worktree: string) =>
        setState({ worktree: normalizeNewSessionWorktree(worktree, sdk().directory, sync().project?.worktree) }),
      disabled: createMemo(() => options.loading || optionsFailed() || !worktreeEnabled()),
      ready: worktreeReady,
      loading: () => options.loading,
      failed: optionsFailed,
      retry: () => void optionsControl.refetch(),
      setBaseBranch: (baseBranch: string) => setState({ baseBranch }),
    },
    project: {
      root: projectRoot,
      workspaces: () => sync().project?.sandboxes ?? [],
      git: () => sync().project?.vcs === "git",
      branches: () => options()?.branches ?? [],
    },
    bar: {
      visible,
      branch,
      baseBranch: selectedBaseBranch,
    },
  }
}

export type NewSessionWorkspaceController = ReturnType<typeof createNewSessionWorkspaceController>
