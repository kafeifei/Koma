import { createMemo, createResource, untrack } from "solid-js"
import { createStore } from "solid-js/store"
import { useSDK } from "@/context/sdk"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { pathKey } from "@/utils/path-key"
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

export function resolveNewSessionBranch(input: { selected?: string; branches: string[]; current?: string }) {
  if (input.selected) return input.selected
  if (input.branches.includes("main")) return "main"
  if (input.branches.includes("dev")) return "dev"
  return input.current ?? input.branches[0]
}

export function createNewSessionWorkspaceController() {
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const serverScope = createMemo(() => sdk().scope)
  const [preference, setPreference, , preferenceReady] = persisted(
    Persist.global("new-session.worktree"),
    createStore({ isolated: true }),
  )
  const branchState = createMemo(() => {
    const target = Persist.serverGlobal(serverScope(), "new-session.branch")
    return untrack(() => persisted(target, createStore({ selected: {} as Record<string, string> })))
  })
  const visible = createMemo(() => workspaceBarEnabled && sync().project?.vcs === "git")
  const projectRoot = createMemo(() => sync().project?.worktree ?? sdk().directory)
  const projectKey = createMemo(() => pathKey(projectRoot()))
  const [result, optionsControl] = createResource(
    () => (visible() ? sdk() : undefined),
    async (target) => {
      try {
        const data = (await target.client.worktree.options({ directory: target.directory })).data
        return { target, data: { ...data, failed: false } }
      } catch {
        return { target, data: { hasHead: false, branches: [], failed: true } }
      }
    },
  )
  const options = createMemo(() => (result()?.target === sdk() ? result()?.data : undefined))
  const optionsFailed = createMemo(() => options()?.failed === true)
  const hasHead = createMemo(() => options()?.hasHead === true)
  const isolated = createMemo(() =>
    resolveNewSessionIsolation({
      visible: visible(),
      preferred: preference.isolated,
      hasHead: hasHead(),
      loading: result.loading,
      failed: optionsFailed(),
    }),
  )
  const currentBranch = createMemo(() => options()?.currentBranch ?? serverSync().child(sdk().directory)[0].vcs?.branch)
  const selectedBranch = createMemo(() =>
    resolveNewSessionBranch({
      selected: branchState()[0].selected[projectKey()],
      branches: options()?.branches ?? [],
      current: currentBranch(),
    }),
  )
  const worktreeReady = createMemo(
    () =>
      preferenceReady() &&
      branchState()[3]() &&
      (!visible() || (!result.loading && !optionsFailed() && (!hasHead() || !!selectedBranch()))),
  )
  const value = createMemo(() => resolveNewSessionWorktree(isolated()))

  return {
    selection: {
      value,
      isolated,
      reset: () => undefined,
      setIsolated: (value: boolean) => setPreference("isolated", value),
      disabled: createMemo(() => !preferenceReady() || result.loading || (!hasHead() && !optionsFailed())),
      ready: worktreeReady,
      loading: () => result.loading,
      failed: optionsFailed,
      retry: () => void optionsControl.refetch(),
      setBaseBranch: (branch: string) => branchState()[1]("selected", projectKey(), branch),
    },
    project: {
      directory: () => sdk().directory,
      root: () => (sync().ready && sync().project ? projectRoot() : undefined),
      git: () => sync().project?.vcs === "git",
      branches: () => options()?.branches ?? [],
    },
    bar: {
      visible,
      branch: selectedBranch,
      currentBranch,
      baseBranch: selectedBranch,
      submitBranch: () => (visible() && hasHead() ? selectedBranch() : undefined),
    },
  }
}

export type NewSessionWorkspaceController = ReturnType<typeof createNewSessionWorkspaceController>
