import type { RemoteAccessPlatform, RemoteAccessState } from "../remote-access"
import type { WebEntryPlatform, WebEntryState } from "../web-entry"

/** Transport only; both hosts run the same remote and web-entry controllers. */
export function createDesktopServices(call: (request: unknown) => Promise<any>) {
  const disposers = new Set<() => void>()
  function service<T>(name: string) {
    const listeners = new Set<(state: T) => void>()
    let previous = ""
    let pending = false
    const publish = (state: T) => {
      const next = JSON.stringify(state)
      if (previous === next) return state
      previous = next
      listeners.forEach((listener) => listener(state))
      return state
    }
    const request = (op: string, args?: object): Promise<T> => call({ service: name, op, ...args }).then(publish)
    const timer = setInterval(async () => {
      if (pending || !listeners.size) return
      pending = true
      try {
        await request("getState")
      } catch (error) {
        console.warn("Desktop service refresh failed", name, error)
      } finally {
        pending = false
      }
    }, 1000)
    disposers.add(() => clearInterval(timer))
    return {
      request,
      getState: () => request("getState"),
      setEnabled: (enabled: boolean) => request("setEnabled", { enabled }),
      subscribe(callback: (state: T) => void) {
        listeners.add(callback)
        return () => {
          listeners.delete(callback)
        }
      },
    }
  }
  const web = service<WebEntryState>("web")
  const remote = service<RemoteAccessState>("remote")
  const remoteAccess: RemoteAccessPlatform = {
    ...remote,
    signIn: () => remote.request("signIn"),
    cancelSignIn: () => remote.request("cancelSignIn"),
    signOut: () => remote.request("signOut"),
    rename: (name) => remote.request("rename", { name }),
    refresh: () => remote.request("refresh"),
    connect: (id) => call({ service: "remote", op: "connect", id }),
    disconnect: (id) => call({ service: "remote", op: "disconnect", id }),
  }
  return { remoteAccess, webEntry: web as WebEntryPlatform, dispose: () => disposers.forEach((dispose) => dispose()) }
}
