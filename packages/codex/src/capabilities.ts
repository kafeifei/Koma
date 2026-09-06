import { CODEX_APP_SERVER_VERSION } from "./transport.js"

/**
 * Runtime observations for the exact pinned binary. Generated protocol types
 * only prove that a method exists in the schema; they do not prove its runtime
 * behavior.
 */
export const CODEX_NATIVE_CAPABILITY_BASELINE = {
  version: CODEX_APP_SERVER_VERSION,
  thread: {
    metadataRead: true,
    metadataResume: true,
    history: {
      legacy: {
        beforeFirstUserMessage: {
          supported: false,
          errorCode: -32600,
          errorMessage: "includeTurns is unavailable before first user message",
        },
        afterMaterialization: { fullRead: true, preservesNativeItemIDs: false, preservesCodeModeTools: false },
      },
      paginated: {
        fullRead: true,
        turnList: true,
        itemList: true,
        preservesNativeItemIDs: true,
        preservesCodeModeTools: true,
        requiresExplicitHistoryModeAtThreadStart: true,
      },
    },
  },
  queue: {
    requiresExperimentalApi: true,
    idleAddBehavior: "startsTurn" as const,
    pausedAfterInterrupt: "unverified" as const,
    safeAsPausedLabQueue: false,
  },
} as const
