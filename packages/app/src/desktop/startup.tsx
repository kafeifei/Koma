import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  useContext,
  type ParentProps,
  type Accessor,
} from "solid-js"
import { usePlatform } from "@/context/platform"
import { useLanguage } from "@/context/language"
import { StartupScreen, startupText, type StartupStage } from "./startup-screen"
import { formatServerError } from "@/utils/server-errors"

export const StartupAppearance = createContext<Accessor<boolean>>(() => true)

// One startup cover for every desktop host. Checks observe existing caches in
// the mounted route; they do not create sessions or take ownership of runtimes.
// Unmounting a route removes its checks, and later navigation never reopens the cover.
export type StartupCheck = { ready: boolean; error?: unknown }
type Task = { stage: StartupStage; check: () => StartupCheck; page: boolean }
const StartupContext = createContext<{
  pending: () => boolean
  add: (task: Task) => void
  remove: (task: Task) => void
}>()

export function startupState(tasks: { stage: StartupStage; state: StartupCheck; page: boolean }[]) {
  const failed = tasks.find((task) => task.state.error)
  const waiting = tasks.find((task) => !task.state.ready)
  return {
    ready: tasks.some((task) => task.page) && !waiting && !failed,
    stage: (failed ?? waiting)?.stage ?? "page",
    error: failed?.state.error,
  }
}

export function useStartupTask(stage: StartupStage, check: () => StartupCheck, page = false) {
  const startup = useContext(StartupContext)
  if (!startup?.pending()) return
  const task = { stage, check, page }
  startup.add(task)
  onCleanup(() => startup.remove(task))
}

export function useStartupPending() {
  return useContext(StartupContext)?.pending ?? (() => false)
}

export function StartupProvider(props: ParentProps) {
  const platform = usePlatform()
  const language = useLanguage()
  const appearanceReady = useContext(StartupAppearance)
  const [done, setDone] = createSignal(platform.platform !== "desktop")
  const [tasks, setTasks] = createSignal<Task[]>([])
  const [timedOut, setTimedOut] = createSignal(false)
  const state = createMemo(() =>
    done()
      ? { ready: true, stage: "page" as const, error: undefined }
      : startupState([
          { stage: "workspace", state: { ready: appearanceReady() }, page: false },
          ...tasks().map((task) => ({ ...task, state: task.check() })),
        ]),
  )
  const timer = setTimeout(() => setTimedOut(true), 45_000)
  onCleanup(() => clearTimeout(timer))

  createEffect(() => {
    if (done() || !state().ready) return
    // Let lazy routes and restored drafts mount, and paint the ready page before
    // removing the cover. New checks or an onboarding redirect cancel this.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setDone(true))
    })
    onCleanup(() => cancelAnimationFrame(frame))
  })
  createEffect(() => {
    if (done()) clearTimeout(timer)
  })
  const error = () => {
    const cause = state().error
    if (cause) return formatServerError(cause, language.t)
    if (timedOut()) return `${startupText(language.locale())[state().stage]}\n${startupText(language.locale()).timeout}`
    return undefined
  }
  return (
    <StartupContext.Provider
      value={{
        pending: () => !done(),
        add: (task) => setTasks((list) => [...list, task]),
        remove: (task) => setTasks((list) => list.filter((item) => item !== task)),
      }}
    >
      <div data-component="startup-workbench" inert={!done()} aria-hidden={!done()} style={{ display: "contents" }}>
        {props.children}
      </div>
      <Show when={!done()}>
        <StartupScreen
          stage={state().stage}
          locale={language.locale()}
          error={error()}
          onContinue={() => setDone(true)}
        />
      </Show>
    </StartupContext.Provider>
  )
}
