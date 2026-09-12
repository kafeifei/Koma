import type { GitHubCredential } from "@opencode-ai/remote/github"

export function createRemoteCredentials(options: {
  storage: {
    isEncryptionAvailable(): boolean
    getSelectedStorageBackend?(): string
    encryptString(value: string): Buffer
    decryptString(value: Buffer): string
  }
  store: { get(key: string): unknown; set(key: string, value: unknown): void; delete(key: string): void }
}) {
  const available = () =>
    options.storage.isEncryptionAvailable() && options.storage.getSelectedStorageBackend?.() !== "basic_text"
  return {
    available,
    read(): GitHubCredential | undefined {
      const value = options.store.get("remoteCredential")
      if (!value) return
      if (!available() || typeof value !== "string") throw new Error("Remote credential storage unavailable")
      const result: unknown = JSON.parse(options.storage.decryptString(Buffer.from(value, "base64")))
      if (
        !result ||
        typeof result !== "object" ||
        !("accessToken" in result) ||
        typeof result.accessToken !== "string"
      ) {
        throw new Error("Invalid remote credential")
      }
      if ("expiresAt" in result && (typeof result.expiresAt !== "number" || !Number.isFinite(result.expiresAt))) {
        throw new Error("Invalid remote credential expiry")
      }
      if ("refreshToken" in result && typeof result.refreshToken !== "string")
        throw new Error("Invalid remote refresh token")
      return result as GitHubCredential
    },
    write(value: GitHubCredential) {
      if (!available()) throw new Error("Remote credential storage unavailable")
      options.store.set("remoteCredential", options.storage.encryptString(JSON.stringify(value)).toString("base64"))
    },
    clear: () => options.store.delete("remoteCredential"),
  }
}
