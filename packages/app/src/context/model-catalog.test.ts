import { expect, test } from "bun:test"
import { providerCodexModel, unifiedModelCatalog } from "./model-catalog"

const native = { id: "gpt-native", name: "GPT Native", default: true, efforts: ["high"] }

test("native Codex discovery becomes a provider entry without changing its execution ID", () => {
  expect(providerCodexModel(native)).toEqual({
    ...native,
    provider: { id: "codex", name: "Codex" },
    modelID: "gpt-native",
  })
  expect(unifiedModelCatalog([], [native])).toEqual([
    { id: "gpt-native", name: "GPT Native", provider: { id: "codex", name: "Codex" }, engines: ["codex"] },
  ])
})

test("both engines share the configured provider's display name and preference key", () => {
  const provider = { id: "xd", name: "XD Gateway" }
  const configured = { ...native, id: "xd/api-model", modelID: "display-model", provider }
  expect(unifiedModelCatalog([{ id: "display-model", name: "My Model", provider }], [configured])).toEqual([
    { id: "display-model", name: "My Model", provider, engines: ["opencode", "codex"] },
  ])
  expect(providerCodexModel(configured).id).toBe("xd/api-model")
})

test("identical model names from different providers remain independent", () => {
  const list = unifiedModelCatalog(
    [{ id: native.id, name: "OpenAI Model", provider: { id: "openai", name: "OpenAI" } }],
    [native, native],
  )
  expect(list).toHaveLength(2)
  expect(list.map((item) => item.provider.id)).toEqual(["openai", "codex"])
  expect(list[1].engines).toEqual(["codex"])
})
