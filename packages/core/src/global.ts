import path from "path"
import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"
import { makeGlobalNode } from "./effect/app-node"
import { StoragePaths } from "./storage-paths"

const app = "opencode"
const configuredRoot = process.env.OPENCODE_HOME?.trim()
if (configuredRoot && !path.isAbsolute(configuredRoot)) {
  throw new Error(`OPENCODE_HOME must be an absolute path: ${configuredRoot}`)
}
const storage = configuredRoot ? StoragePaths.resolve(configuredRoot) : undefined
if (storage) StoragePaths.database(storage.root)
const data = storage?.data ?? path.join(xdgData!, app)
const cache = storage?.cache ?? path.join(xdgCache!, app)
const config = storage?.config ?? path.join(xdgConfig!, app)
const state = storage?.state ?? path.join(xdgState!, app)
const tmp = path.join(os.tmpdir(), app)

const paths = {
  get home() {
    return process.env.OPENCODE_TEST_HOME ?? os.homedir()
  },
  root: storage?.root,
  desktop: storage?.desktop,
  data,
  bin: path.join(cache, "bin"),
  log: storage?.log ?? path.join(data, "log"),
  repos: storage?.repos ?? path.join(data, "repos"),
  worktree: storage?.worktree ?? path.join(data, "worktree"),
  snapshot: storage?.snapshot ?? path.join(data, "snapshot"),
  codex: storage?.codex,
  cache,
  config,
  state,
  tmp,
}

export const Path = paths

Flock.setGlobal({ state })

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.tmp, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
  fs.mkdir(Path.repos, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export interface Interface {
  readonly home: string
  readonly root?: string
  readonly desktop?: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
  readonly worktree?: string
  readonly snapshot?: string
  readonly codex?: string
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    root: Path.root,
    desktop: Path.desktop,
    data: Path.data,
    cache: Path.cache,
    config: Flag.OPENCODE_CONFIG_DIR ?? Path.config,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    worktree: Path.worktree,
    snapshot: Path.snapshot,
    codex: Path.codex,
    ...input,
    ...StoragePaths.overrides(input, Path),
  }
}

const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
