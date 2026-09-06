import { type Accessor, createEffect, createResource, onCleanup } from "solid-js"
import { type CompatibleApi, sessionCapabilities, subscribeSessionCapabilities } from "./server-compat"

/** Keep disabled entry points in sync when another consumer retries the shared capability request. */
export function createSessionCapabilities(source: Accessor<CompatibleApi | undefined>) {
  const [capabilities, actions] = createResource(source, (api) => sessionCapabilities(api).catch(() => undefined))
  createEffect(() => {
    const api = source()
    actions.mutate(undefined)
    if (!api) return
    onCleanup(
      subscribeSessionCapabilities(api, (value) => {
        if (source()?.session === api.session) actions.mutate(value)
      }),
    )
  })
  if (typeof window !== "undefined") {
    const retry = () => {
      if (source() && capabilities() === undefined && !capabilities.loading) void actions.refetch()
    }
    window.addEventListener("focus", retry)
    onCleanup(() => window.removeEventListener("focus", retry))
  }
  return capabilities
}
