import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { hostname } from "node:os"
import { z } from "zod"
import { createRemoteAccess } from "./remote-access"
import { createWebEntryController } from "./web-entry-controller"

export function createDesktopHostServices(options: {
  profile?: string
  directory: string
  renderer: string
  backend: Parameters<typeof createRemoteAccess>[0]["backend"]
  credentials: Parameters<typeof createRemoteAccess>[0]["credentials"]
}) {
  const { renderer, backend, credentials, directory } = options
  // These are the host's listener ports and device identity, not renderer data.
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = join(directory, "settings.json")
  const read = (): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(file, "utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
      throw error
    }
  }
  const settings = {
    get: (key: string) => read()[key],
    set(key: string, value: unknown) {
      const temporary = `${file}.${randomUUID()}.tmp`
      writeFileSync(temporary, JSON.stringify({ ...read(), [key]: value }), { mode: 0o600 })
      renameSync(temporary, file)
    },
  }
  const web = createWebEntryController({ backend, root: renderer, settings, changed: () => {}, failed: console.error })
  const remote = createRemoteAccess({
    backend,
    profile: options.profile,
    root: renderer,
    settings,
    clientOrigin: "tauri://localhost",
    credentials,
    deviceName: `${hostname()} (Tauri)`,
    website: process.env.OPENCODE_REMOTE_WEBSITE,
    changed: () => {},
    failed: (failure) => console.warn("Desktop remote access", failure),
  })
  void web.initialize()
  void remote.initialize()
  return {
    web,
    remote,
    request: (payload: unknown): Promise<unknown> => desktopServiceRequest({ web, remote }, payload),
    stop: () => Promise.all([web.stop(), remote.stop()]).then(() => undefined),
  }
}

const action = z.discriminatedUnion("service", [
  z.object({ service: z.literal("web"), op: z.enum(["getState", "setEnabled"]), enabled: z.boolean().optional() }),
  z.object({
    service: z.literal("remote"),
    op: z.enum([
      "getState",
      "signIn",
      "cancelSignIn",
      "signOut",
      "setEnabled",
      "rename",
      "refresh",
      "connect",
      "disconnect",
    ]),
    enabled: z.boolean().optional(),
    name: z.string().trim().min(1).max(40).optional(),
    id: z.string().min(1).max(200).optional(),
  }),
])

async function desktopServiceRequest(
  host: Pick<ReturnType<typeof createDesktopHostServices>, "web" | "remote">,
  payload: unknown,
): Promise<unknown> {
  const input = action.parse(payload)
  if (input.op === "setEnabled") {
    if (input.enabled === undefined) throw new Error("Missing enabled preference")
    return host[input.service].setEnabled(input.enabled)
  }
  if (input.service === "web") return host.web.getState()
  if (input.op === "rename") {
    if (!input.name) throw new Error("Missing device name")
    return host.remote.rename(input.name)
  }
  if (input.op === "connect" || input.op === "disconnect") {
    if (!input.id) throw new Error("Missing device identifier")
    return host.remote[input.op](input.id)
  }
  return host.remote[input.op]()
}
