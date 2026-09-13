import data from "./catalog.recipes.json"

export type ResourceFile = { path: string; url: string; sha256: string }
export type FileRecipe = {
  type: "files"
  version: string
  verifiedAt: string
  entry: string | null
  defaultExport?: boolean
  files: ResourceFile[]
  dependencies: Record<string, string>
  instructions?: string[]
  config?: { permission?: Record<string, string> }
  note?: string
  noteZh?: string
}
export type Recipe =
  | FileRecipe
  | { type: "npm"; spec: string; verifiedAt: string; note?: string; noteZh?: string }
  | { type: "builtin" | "external"; note: string; noteZh: string }

// These recipes bind the publisher's project URL to its actual package or
// immutable source files. Display names and remote catalog prose are not code.
export const recipes: Record<string, Recipe> = data as Record<string, Recipe>
