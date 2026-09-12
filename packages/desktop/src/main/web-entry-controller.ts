import { createWebEntryController as createController } from "@opencode-ai/remote/desktop/web-entry-controller"
import { getStore } from "./store"
export function createWebEntryController(options: Omit<Parameters<typeof createController>[0], "settings">) {
  return createController({ ...options, settings: getStore() })
}
