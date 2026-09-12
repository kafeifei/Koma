import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { installKomaCli } from "../src/main/koma-cli"
import { KomaProfile } from "@opencode-ai/core/koma-profile"

const source =
  process.argv[2] ?? join(import.meta.dir, "../resources", process.platform === "win32" ? "koma.exe" : "koma")
// Ask the artifact for its baked distribution, rather than guessing from this shell.
const child = Bun.spawn([resolve(source), "backend", "paths"], { stdout: "pipe", stderr: "inherit" })
const paths = await new Response(child.stdout).json()
if ((await child.exited) !== 0 || !["release", "debug"].includes(paths.distribution)) {
  throw new Error("The Koma CLI did not report a valid distribution")
}
process.env.KOMA_DISTRIBUTION = paths.distribution
console.log(
  await installKomaCli({
    source: resolve(source),
    root: paths.profile,
    linkName: KomaProfile.commandName(),
    // Explicit homes keep every test installation inside that home.
    linkDirectory:
      process.env.KOMA_HOME || process.env.OPENCODE_HOME || process.platform === "win32"
        ? undefined
        : join(homedir(), ".local/bin"),
  }),
)
