import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { realpath, mkdir, writeFile, rm } from "node:fs/promises"
import { basename, dirname, join, relative, resolve } from "node:path"

// Native UI acceptance copies must never open the user's profile or Keychain.
// These copies are deliberately outside /Applications and must not be delivered.
const repository = resolve(import.meta.dir, "../../..")
const boundary = await realpath(join(repository, ".local/desktop-tests"))
const [source, destination, profile] = process.argv.slice(2).map((path) => resolve(path))
if (!source || !destination || !profile) throw new Error("Expected source.app destination.app test-profile")
for (const path of [destination, profile]) {
  await mkdir(dirname(path), { recursive: true })
  const parent = await realpath(dirname(path))
  if (!relative(boundary, parent) || !relative(boundary, parent).startsWith("..")) continue
  throw new Error("Validation copies and profiles must stay under .local/desktop-tests")
}
await mkdir(profile, { recursive: true })
const actualProfile = await realpath(profile)
if (relative(boundary, actualProfile).startsWith("..")) throw new Error("Test profile escapes the validation directory")
if (await Bun.file(join(profile, "desktop/opencode.settings")).exists()) {
  const settings = await Bun.file(join(profile, "desktop/opencode.settings")).json()
  if (settings.remoteCredential) throw new Error("Validation requires a profile without saved credentials")
}
if (await Bun.file(join(destination, "Contents/Info.plist")).exists()) throw new Error("Destination already exists")
const plist = JSON.parse(
  execFileSync("plutil", ["-convert", "json", "-o", "-", join(source, "Contents/Info.plist")], { encoding: "utf8" }),
)
const electron = await Bun.file(
  join(source, "Contents/Frameworks/Electron Framework.framework/Electron Framework"),
).exists()
if (electron && (!/Validation/.test(plist.CFBundleName) || plist.CFBundleName !== basename(destination, ".app"))) {
  throw new Error(
    "Build Electron with a unique Validation productName first; renaming only its plist breaks native menus",
  )
}
execFileSync("ditto", [source, destination])
const plistPath = join(destination, "Contents/Info.plist")
plist.CFBundleIdentifier += ".validation-" + createHash("sha256").update(destination).digest("hex").slice(0, 12)
plist.CFBundleName = basename(destination, ".app")
plist.CFBundleDisplayName = plist.CFBundleName
plist.LSEnvironment = {
  KOMA_HOME: actualProfile,
  OPENCODE_HOME: actualProfile,
  OPENCODE_DISABLE_MODELS_FETCH: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_EXTERNAL_SERVICES: "1",
}
if (electron) {
  const builder = Bun.resolveSync("electron-builder", import.meta.dir)
  const lib = Bun.resolveSync("app-builder-lib", builder)
  const asar = await import(Bun.resolveSync("@electron/asar", lib))
  const archive = join(destination, "Contents/Resources/app.asar")
  const stage = `${destination}.validation-source`
  asar.extractAll(archive, stage)
  const manifestPath = join(stage, "package.json")
  const manifest = await Bun.file(manifestPath).json()
  const entrypoint = manifest.main
  manifest.main = "validation-main.mjs"
  const environment = JSON.stringify(plist.LSEnvironment)
  // Dynamic import ensures isolation is active before production imports run.
  const entry = `import { app } from "electron";
Object.assign(process.env, ${environment});
app.setPath("userData", ${JSON.stringify(join(actualProfile, "desktop"))});
app.commandLine.appendSwitch("use-mock-keychain");
await import(${JSON.stringify(`./${entrypoint.replace(/^\.\//, "")}`)});
`
  await mkdir(join(actualProfile, "desktop"), { recursive: true })
  await writeFile(join(stage, manifest.main), entry)
  await writeFile(manifestPath, JSON.stringify(manifest))
  await asar.createPackageWithOptions(stage, archive, { unpackDir: "node_modules" })
  asar.uncache(archive)
  plist.ElectronAsarIntegrity = {
    "Resources/app.asar": {
      algorithm: "SHA256",
      hash: createHash("sha256").update(asar.getRawHeader(archive).headerString).digest("hex"),
    },
  }
  await rm(stage, { recursive: true })
}
await writeFile(plistPath, JSON.stringify(plist))
execFileSync("plutil", ["-convert", "xml1", plistPath])
execFileSync("codesign", ["--force", "--deep", "--sign", "-", destination])
console.log(
  JSON.stringify({
    destination,
    profile: actualProfile,
    keychain: electron ? "mock (test only)" : "native separate service",
  }),
)
