import { net, safeStorage } from "electron"
import { createRemoteAccess as createPortableRemoteAccess } from "@opencode-ai/remote/desktop/remote-access"
import { createRemoteCredentials } from "./remote-credentials"
import { getStore } from "./store"

export function createRemoteAccess(
  options: Omit<Parameters<typeof createPortableRemoteAccess>[0], "credentials" | "settings">,
) {
  const settings = getStore()
  const legacy = createRemoteCredentials({ storage: safeStorage, store: settings })
  return createPortableRemoteAccess({
    ...options,
    settings,
    credentials: legacy,
    fetch: (url, init) => net.fetch(url instanceof URL ? url.href : url, init),
    website: process.env.OPENCODE_REMOTE_WEBSITE || import.meta.env.OPENCODE_REMOTE_WEBSITE,
  })
}
