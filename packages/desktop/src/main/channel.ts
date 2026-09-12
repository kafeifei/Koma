export type DesktopChannel = "dev" | "lab" | "beta" | "prod"

const identities = {
  dev: { appId: "com.kafeifei.koma.debug", name: "Koma Debug", scheme: "koma", icon: "koma" },
  lab: { appId: "com.kafeifei.koma.debug", name: "Koma Debug", scheme: "koma", icon: "koma" },
  beta: { appId: "com.kafeifei.koma", name: "Koma", scheme: "koma", icon: "koma" },
  prod: { appId: "com.kafeifei.koma", name: "Koma", scheme: "koma", icon: "koma" },
} as const

export function resolveDesktopChannel(value: string | undefined): DesktopChannel {
  if (value === "dev" || value === "lab" || value === "beta" || value === "prod") return value
  return "lab"
}

export function desktopIdentity(channel: DesktopChannel, release = false) {
  return identities[release ? "prod" : channel]
}

export function desktopUpdaterEnabled(packaged: boolean, channel: DesktopChannel) {
  return false
}
