import { homedir } from "node:os"
import { join } from "node:path"

// Koma: the identity this fork is packaged under. A packaged build never shares an installed OpenCode's name, bundle
// ID, URL scheme, background service or database. The unpackaged dev run keeps upstream's dev identity.
//
// `service` is the channel the bundled CLI is built for (`OPENCODE_CHANNEL`). The CLI names its database
// (`opencode-<service>.db`) and its registration file (`service-<service>.json`) after it. `port` is fixed and below
// 49152, the start of the range the OS hands out for outgoing connections, so no other process is given it by chance.
export const KOMA = {
  dev: { appName: "Koma Debug", appID: "com.kafeifei.koma.debug", service: "koma-debug", port: 19277 },
  beta: { appName: "Koma Beta", appID: "com.kafeifei.koma.beta", service: "koma-beta", port: 19278 },
  prod: { appName: "Koma", appID: "com.kafeifei.koma", service: "koma", port: 19279 },
} as const

export type KomaChannel = keyof typeof KOMA

/** Where the bundled CLI registers its service, following the CLI's own naming in `cli/src/services/service-config.ts`. */
export function komaServiceFile(channel: KomaChannel) {
  return join(
    process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
    "opencode",
    `service-${KOMA[channel].service}.json`,
  )
}
