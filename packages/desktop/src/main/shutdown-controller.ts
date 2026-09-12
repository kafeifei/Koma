import { createShutdownController as createController } from "@opencode-ai/app/desktop/shutdown-controller"

export function createShutdownController(options: Parameters<typeof createController>[0]) {
  return createController({ ...options, schedule: options.schedule ?? setImmediate })
}
