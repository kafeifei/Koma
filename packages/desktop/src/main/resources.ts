import { app } from "electron"
import { createRequire } from "node:module"
import { join } from "node:path"
import { snapshotRuntimeResources } from "./runtime-resources"

let root = app.getAppPath()

export function initializeRuntimeResources() {
  if (!app.isPackaged || !root.endsWith(".asar")) return { dispose() {} }
  const io = createRequire(import.meta.url)("original-fs") as typeof import("node:fs")
  const snapshot = snapshotRuntimeResources(root, app.getPath("temp"), io)
  root = snapshot.root
  return snapshot
}

export function runtimePath(...segments: string[]) {
  return join(root, "out", ...segments)
}
