import { confirmDesktopShutdown } from "@opencode-ai/app/desktop/shutdown"
import { nativeT } from "./native-translations"

export function confirmBackendShutdown(input: Omit<Parameters<typeof confirmDesktopShutdown>[0], "translate">) {
  return confirmDesktopShutdown({ ...input, translate: nativeT })
}
