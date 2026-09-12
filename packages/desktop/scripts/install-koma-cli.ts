import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { installKomaCli } from "../src/main/koma-cli"
import { KomaProfile } from "@opencode-ai/core/koma-profile"

const source =
  process.argv[2] ?? join(import.meta.dir, "../resources", process.platform === "win32" ? "koma.exe" : "koma")
console.log(
  await installKomaCli({
    source: resolve(source),
    root: KomaProfile.resolveHome(),
    // Explicit homes keep every test installation inside that home.
    linkDirectory:
      process.env.KOMA_HOME || process.env.OPENCODE_HOME || process.platform === "win32"
        ? undefined
        : join(homedir(), ".local/bin"),
  }),
)
