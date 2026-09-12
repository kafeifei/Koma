import type { LabEnginesOutput } from "@opencode-ai/lab-client"

type CodexModel = LabEnginesOutput[number]["models"][number]
export type CatalogModel = {
  id: string
  name: string
  provider: { id: string; name: string }
  engines: Array<"opencode" | "codex">
}

/** Preserve execution IDs; native model names are grouped under their own provider identity. */
export function providerCodexModel(model: CodexModel) {
  return {
    ...model,
    provider: model.provider ?? { id: "codex", name: "Codex" },
    modelID: model.modelID ?? model.id,
  }
}

export function unifiedModelCatalog(
  opencode: Array<{ id: string; name: string; provider: { id: string; name: string } }>,
  codex: readonly CodexModel[],
): CatalogModel[] {
  const key = (provider: string, model: string) => JSON.stringify([provider, model])
  const result = new Map<string, CatalogModel>(
    opencode.map((model) => [key(model.provider.id, model.id), { ...model, engines: ["opencode"] }]),
  )
  for (const value of codex) {
    const model = providerCodexModel(value)
    const id = key(model.provider.id, model.modelID)
    const existing = result.get(id)
    if (existing) {
      if (!existing.engines.includes("codex")) existing.engines.push("codex")
      continue
    }
    result.set(id, { id: model.modelID, name: model.name, provider: model.provider, engines: ["codex"] })
  }
  return [...result.values()]
}
