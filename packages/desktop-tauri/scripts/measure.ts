import { readdir, lstat, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { packageRoot, testRoot } from "./paths"

const phase = process.argv[2] ?? "size"
if (!/^[a-z0-9-]+$/.test(phase)) throw new Error("Use a simple lowercase phase name")
const app = join(packageRoot, "src-tauri/target/release/bundle/macos/OpenCode Lab Tauri Test.app")
async function inventory(directory: string): Promise<{ path: string; bytes: number; allocatedBytes: number }[]> {
  const output = []
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const info = await lstat(path)
    if (info.isDirectory()) output.push(...(await inventory(path)))
    else output.push({ path: path.slice(app.length + 1), bytes: info.size, allocatedBytes: info.blocks * 512 })
  }
  return output
}
const files = await inventory(app)
const processes = process.argv.slice(3).map((argument) => {
  const match = /^([a-z-]+)=(\d+)$/.exec(argument)
  if (!match) throw new Error(`Expected role=pid: ${argument}`)
  const [, role, pid] = match
  const ps = execFileSync("ps", ["-p", pid!, "-o", "pid=,ppid=,rss=,etime=,comm="], { encoding: "utf8" }).trim()
  const summary = execFileSync("vmmap", ["-summary", pid!], { encoding: "utf8" })
  return {
    role,
    pid: Number(pid),
    ps,
    physicalFootprint: /^Physical footprint:\s*(.+)$/m.exec(summary)?.[1]?.trim() ?? null,
    physicalFootprintPeak: /^Physical footprint \(peak\):\s*(.+)$/m.exec(summary)?.[1]?.trim() ?? null,
  }
})
const result = {
  measuredAt: new Date().toISOString(),
  phase,
  app,
  platform: execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
  logicalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  allocatedFileBytes: files.reduce((sum, file) => sum + file.allocatedBytes, 0),
  files,
  processes,
  note: "Process roles are supplied after manual attribution. RSS includes shared mappings. Do not treat host-only memory as total application memory or compare unlike workloads.",
}
await mkdir(join(testRoot, "results"), { recursive: true })
const output = join(testRoot, "results", `tauri-${phase}.json`)
await writeFile(output, JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
console.log(`Saved ${output}`)
