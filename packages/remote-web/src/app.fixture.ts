import { render } from "solid-js/web"
import { App } from "./app"
import { remoteWeb } from "./client"

export function configure(overrides: Partial<typeof remoteWeb>) {
  Object.assign(remoteWeb, overrides)
}

export function mount() {
  const root = document.createElement("div")
  document.body.append(root)
  return { root, dispose: render(App, root) }
}
