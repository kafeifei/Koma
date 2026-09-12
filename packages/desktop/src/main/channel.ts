export type DesktopChannel = "dev" | "lab" | "beta" | "prod"

const identities = {
  dev: { appId: "ai.opencode.desktop.dev", name: "OpenCode Dev", scheme: "opencode", icon: "dev" },
  lab: { appId: "ai.opencode.lab", name: "Koma", scheme: "opencode-lab", icon: "dev" },
  beta: { appId: "ai.opencode.desktop.beta", name: "OpenCode Beta", scheme: "opencode", icon: "beta" },
  prod: { appId: "ai.opencode.desktop", name: "OpenCode", scheme: "opencode", icon: "prod" },
} as const

export function resolveDesktopChannel(value: string | undefined): DesktopChannel {
  if (value === "dev" || value === "lab" || value === "beta" || value === "prod") return value
  return "dev"
}

export function desktopIdentity(channel: DesktopChannel) {
  return identities[channel]
}

export function desktopUpdaterEnabled(packaged: boolean, channel: DesktopChannel) {
  return packaged && (channel === "beta" || channel === "prod")
}
