import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { installLabCli } from "../src/main/lab-cli"

const source =
  process.argv[2] ??
  join(import.meta.dir, "../resources", process.platform === "win32" ? "opencode-lab.exe" : "opencode-lab")
console.log(
  await installLabCli({
    source: resolve(source),
    root: process.env.OPENCODE_HOME ?? join(homedir(), ".opencode"),
    // Explicit homes keep every test installation inside that home.
    linkDirectory:
      process.env.OPENCODE_HOME || process.platform === "win32" ? undefined : join(homedir(), ".local/bin"),
  }),
)
