import { createHash } from "node:crypto"
import { z } from "zod"

const credential = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.number().finite().optional(),
  refreshToken: z.string().optional(),
})
export function createKomaCredentials(root: string, secrets = Bun.secrets) {
  const key = { service: "com.kafeifei.koma.remote.tauri", name: createHash("sha256").update(root).digest("hex") }
  let pending: Promise<unknown> = Promise.resolve()
  const queue = <T>(action: () => Promise<T>) => {
    const result = pending.then(action)
    pending = result.catch(() => {})
    return result
  }
  return {
    available: () => !!secrets,
    read: () =>
      queue(async () => {
        const value = await secrets.get(key)
        return value ? credential.parse(JSON.parse(value)) : undefined
      }),
    write: (value: unknown) =>
      queue(async () => {
        await secrets.set({ ...key, value: JSON.stringify(credential.parse(value)) })
      }),
    clear: () =>
      queue(async () => {
        await secrets.delete(key)
      }),
  }
}
