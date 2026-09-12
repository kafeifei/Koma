const ALLOWED_MODELS = new Set(["gpt-5.5", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini"])
const DISALLOWED_MODELS = new Set(["gpt-5.5-pro"])

export function supportsOpenAIOAuthModel(model: { api: { id: string }; options: Record<string, unknown> }) {
  if (model.options.reasoningMode === "pro") return false
  if (ALLOWED_MODELS.has(model.api.id)) return true
  if (DISALLOWED_MODELS.has(model.api.id)) return false
  if (model.api.id === "gpt-5.6") return false
  const match = model.api.id.match(/^gpt-(\d+)(?:\.(\d+))?/)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  return major > 5 || (major === 5 && minor > 4)
}
