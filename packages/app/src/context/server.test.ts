import type { RemoteAccessState } from "@/remote-access"
import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import {
  createServerProjects,
  migrateCanonicalLocalServerState,
  migrateRemoteServers,
  nextServerAfterRemoval,
  resolveServerList,
  ServerConnection,
} from "./server"
import { ServerScope } from "@/utils/server-scope"

describe("resolveServerList", () => {
  test("lets startup auth_token credentials override a persisted same-url server", () => {
    const list = resolveServerList({
      stored: [{ url: "https://server.example.test" }],
      props: [
        {
          type: "http",
          authToken: true,
          http: {
            url: "https://server.example.test",
            username: "opencode",
            password: "secret",
          },
        },
      ],
    })

    expect(list).toHaveLength(1)
    expect(list[0]?.type).toBe("http")
    expect(list[0]?.http).toEqual({
      url: "https://server.example.test",
      username: "opencode",
      password: "secret",
    })
    expect(list[0]?.type === "http" ? list[0].authToken : false).toBe(true)
    expect(ServerConnection.key(list[0]!) as string).toBe("https://server.example.test")
  })

  test("keeps persisted credentials when startup has no auth_token", () => {
    const list = resolveServerList({
      stored: [
        {
          url: "https://server.example.test",
          username: "opencode",
          password: "saved",
        },
      ],
      props: [{ type: "http", http: { url: "https://server.example.test" } }],
    })

    expect(list).toHaveLength(1)
    expect(list[0]?.type).toBe("http")
    expect(list[0]?.http).toEqual({
      url: "https://server.example.test",
      username: "opencode",
      password: "saved",
    })
    expect(list[0]?.type === "http" ? list[0].authToken : true).toBeUndefined()
  })
})

test("treats WSL sidecars as remote server connections", () => {
  expect(
    ServerConnection.local({
      type: "sidecar",
      variant: "wsl",
      distro: "Debian",
      http: { url: "http://127.0.0.1:4097" },
    }),
  ).toBe(false)
  expect(ServerConnection.local({ type: "sidecar", variant: "base", http: { url: "http://127.0.0.1:4096" } })).toBe(
    true,
  )
  expect(ServerConnection.local({ type: "http", http: { url: "http://localhost:4096" } })).toBe(true)
  expect(ServerConnection.local({ type: "http", http: { url: "https://server.example.test" } })).toBe(false)
})

test("active server removal falls back across built-in and persisted servers", () => {
  const local = { type: "sidecar", variant: "base", http: { url: "http://127.0.0.1:4096" } } as const
  const debian = {
    type: "sidecar",
    variant: "wsl",
    distro: "Debian",
    http: { url: "http://127.0.0.1:4097" },
  } as const

  expect(
    nextServerAfterRemoval(
      [local, debian],
      ServerConnection.Key.make("wsl:Debian"),
      ServerConnection.Key.make("sidecar"),
    ),
  ).toBe(ServerConnection.Key.make("sidecar"))
})

describe("createServerProjects", () => {
  test("keeps active and explicit server buckets in one reactive store", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const active = createServerProjects({ scope, store, setStore })
      const remote = createServerProjects({ scope: () => "https://debian.example" as ServerScope, store, setStore })

      remote.open("/repo")
      expect(remote.list()).toEqual([{ worktree: "/repo", expanded: true }])
      expect(active.list()).toEqual([])

      const adopted = createServerProjects({ scope: () => "https://debian.example" as ServerScope, store, setStore })
      expect(adopted.list()).toEqual([{ worktree: "/repo", expanded: true }])

      adopted.close("/repo")
      expect(remote.list()).toEqual([])
      dispose()
    })
  })

  test("tracks recently closed projects and drops them when reopened", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const projects = createServerProjects({ scope, store, setStore })

      projects.open("/a")
      projects.open("/b")
      projects.close("/a")
      expect(projects.recentlyClosed()).toEqual(["/a"])

      projects.close("/b")
      expect(projects.recentlyClosed()).toEqual(["/b", "/a"])

      projects.open("/a")
      expect(projects.recentlyClosed()).toEqual(["/b"])
      expect(projects.list()).toEqual([{ worktree: "/a", expanded: true }])
      dispose()
    })
  })

  test("remove drops a project without recording it as recently closed", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const projects = createServerProjects({ scope, store, setStore })

      projects.open("/repo/subdir")
      projects.remove("/repo/subdir")
      expect(projects.list()).toEqual([])
      expect(projects.recentlyClosed()).toEqual([])
      dispose()
    })
  })

  test("retains recently closed history beyond the visible display limit", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const projects = createServerProjects({ scope, store, setStore })

      // Closing 6 projects keeps all 6 in the store even though only 5 are displayed;
      // this prevents display-filtered entries from evicting still-visible ones.
      for (const dir of ["/1", "/2", "/3", "/4", "/5", "/6"]) {
        projects.open(dir)
        projects.close(dir)
      }
      expect(projects.recentlyClosed()).toEqual(["/6", "/5", "/4", "/3", "/2", "/1"])
      dispose()
    })
  })

  test("caps recently closed history at the store limit", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const projects = createServerProjects({ scope, store, setStore })

      for (let i = 1; i <= 20; i++) {
        projects.open(`/p${i}`)
        projects.close(`/p${i}`)
      }
      expect(projects.recentlyClosed()).toHaveLength(16)
      expect(projects.recentlyClosed()[0]).toBe("/p20")
      expect(projects.recentlyClosed().at(-1)).toBe("/p5")
      dispose()
    })
  })

  test("dedupes recently closed entries by normalized path", () => {
    createRoot((dispose) => {
      const [scope] = createSignal(ServerScope.local)
      const [store, setStore] = createStore({ projects: {}, lastProject: {}, recentlyClosed: {} })
      const projects = createServerProjects({ scope, store, setStore })

      projects.close("/repo")
      projects.close("/repo/")
      expect(projects.recentlyClosed()).toEqual(["/repo/"])
      dispose()
    })
  })

  test("normalizes persisted aliases atomically while preserving order and expansion", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore({
        projects: {
          local: [
            { worktree: "/worktrees/feature", expanded: false },
            { worktree: "/code/other", expanded: false },
            { worktree: "/code/repo", expanded: true },
          ],
        },
        lastProject: { local: "/worktrees/feature" },
        recentlyClosed: { local: ["/worktrees/feature", "/code/repo", "/code/closed"] },
      })
      const projects = createServerProjects({ scope: () => ServerScope.local, store, setStore })

      projects.normalize((directory) => (directory === "/worktrees/feature" ? "/code/repo" : directory))

      expect(projects.list()).toEqual([
        { worktree: "/code/repo", expanded: true },
        { worktree: "/code/other", expanded: false },
      ])
      expect(projects.last()).toBe("/code/repo")
      expect(projects.recentlyClosed()).toEqual(["/code/repo", "/code/closed"])
      dispose()
    })
  })

  test("keeps project actions stable after normalizing aliases beside a formatted root", () => {
    createRoot((dispose) => {
      const [store, setStore] = createStore({
        projects: {
          local: [{ worktree: "/code/other", expanded: true }],
          remote: [
            { worktree: "/code/repo/", expanded: false },
            { worktree: "/worktrees/feature", expanded: false },
          ],
        },
        lastProject: { remote: "/worktrees/feature" },
        recentlyClosed: { remote: ["/worktrees/closed"] },
      })
      const projects = createServerProjects({ scope: () => "remote" as ServerScope, store, setStore })
      const resolve = (directory: string) =>
        directory === "/worktrees/feature"
          ? "/code/repo"
          : directory === "/worktrees/closed"
            ? "/code/closed"
            : directory

      projects.normalize(resolve)
      projects.normalize(resolve)
      projects.expand("/code/repo")
      projects.collapse("/code/repo")
      expect(projects.list()[0]).toEqual({ worktree: "/code/repo/", expanded: false })
      projects.expand("/code/repo")
      projects.open("/code/new")
      projects.move("/code/repo", 0)
      expect(projects.list().map((project) => project.worktree)).toEqual(["/code/repo/", "/code/new"])
      projects.touch("/code/repo")
      projects.close("/code/repo")
      expect(projects.list()).toEqual([{ worktree: "/code/new", expanded: true }])
      projects.open("/code/repo")

      expect(projects.list()).toEqual([
        { worktree: "/code/repo", expanded: true },
        { worktree: "/code/new", expanded: true },
      ])
      expect(projects.last()).toBeUndefined()
      expect(projects.recentlyClosed()).toEqual(["/code/closed"])
      expect(store.projects.local).toEqual([{ worktree: "/code/other", expanded: true }])
      dispose()
    })
  })
})

describe("migrateCanonicalLocalServerState", () => {
  test("migrates session membership without replacing an explicit local Recent assignment", () => {
    expect(
      migrateCanonicalLocalServerState(
        {
          sessionProjects: {
            "https://opencode.example.com": { a: "/repo", b: "/other" },
            local: { a: null },
          },
        },
        ServerConnection.Key.make("https://opencode.example.com"),
      ),
    ).toEqual({ sessionProjects: { local: { a: null, b: "/other" } } })
  })
  test("moves an existing canonical web bucket into local scope", () => {
    expect(
      migrateCanonicalLocalServerState(
        {
          list: [],
          projects: { "https://opencode.example.com": [{ worktree: "/remote", expanded: true }] },
          lastProject: { "https://opencode.example.com": "/remote" },
        },
        ServerConnection.Key.make("https://opencode.example.com"),
      ),
    ).toEqual({
      list: [],
      projects: { local: [{ worktree: "/remote", expanded: true }] },
      lastProject: { local: "/remote" },
    })
  })

  test("preserves existing local state while merging a canonical web bucket", () => {
    expect(
      migrateCanonicalLocalServerState(
        {
          projects: {
            local: [{ worktree: "/local", expanded: false }],
            "https://opencode.example.com": [
              { worktree: "/local", expanded: true },
              { worktree: "/remote", expanded: true },
            ],
          },
          lastProject: { local: "/local", "https://opencode.example.com": "/remote" },
        },
        ServerConnection.Key.make("https://opencode.example.com"),
      ),
    ).toEqual({
      projects: {
        local: [
          { worktree: "/local", expanded: false },
          { worktree: "/remote", expanded: true },
        ],
      },
      lastProject: { local: "/local" },
    })
  })
})

test("remote connection migration removes self entries and isolates sibling listener URLs", () => {
  const stored = [
    { type: "http" as const, displayName: "This Tauri", http: { url: "http://127.0.0.1:4200" } },
    { type: "http" as const, displayName: "Other computer", http: { url: "http://127.0.0.1:4300" } },
    { type: "http" as const, displayName: "Manual HTTP", http: { url: "http://localhost:5000" } },
  ]
  const migrated = migrateRemoteServers(stored, {
    connections: [
      { id: "self", clientID: "electron", url: "http://127.0.0.1:4200", current: true },
      { id: "remote", clientID: "electron", url: "http://127.0.0.1:4300", current: false },
    ],
  } as RemoteAccessState)
  expect(migrated).toHaveLength(2)
  expect(resolveServerList({ stored: migrated, clientID: "tauri" }).map((conn) => conn.displayName)).toEqual([
    "Manual HTTP",
  ])
  const electron = resolveServerList({ stored: migrated, clientID: "electron" })
  expect(electron.map((conn) => conn.displayName)).toEqual(["Other computer", "Manual HTTP"])
  const remote = electron[0] as ServerConnection.Http
  const rebound = { ...remote, http: { url: "http://127.0.0.1:4301" } }
  expect(ServerConnection.key(rebound)).toBe(ServerConnection.Key.make("http://127.0.0.1:4300"))
  expect(ServerConnection.local(remote)).toBe(false)
  expect(ServerConnection.local(electron[1])).toBe(true)
})
