export function taskToolSubtitle(
  input: Record<string, unknown>,
  metadata: Record<string, unknown> | undefined,
  fallback?: string,
) {
  const description = typeof input.description === "string" && input.description ? input.description : fallback
  const model = metadata?.model
  const providerID = isRecord(model) && typeof model.providerID === "string" ? model.providerID : undefined
  const modelID = isRecord(model) && typeof model.modelID === "string" ? model.modelID : undefined
  const variant = typeof metadata?.variant === "string" ? metadata.variant : undefined
  return (
    [description, providerID && modelID ? `${providerID}/${modelID}` : undefined, variant]
      .filter(Boolean)
      .join(" \u00B7 ") || undefined
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
