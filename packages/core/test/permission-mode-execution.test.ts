import { expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import path from "path"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { BashTool } from "@opencode-ai/core/tool/bash"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { toolIdentity } from "./lib/tool"

const config = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Location.node,
      Database.node,
      AgentV2.node,
      PermissionV2.node,
      PermissionSaved.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      BashTool.node,
    ]),
    [
      [Location.node, tempLocationLayer],
      [Config.node, config],
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    ],
  ),
)

it.live(
  "real shell execution follows the current backend mode even for an already advertised tool",
  () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const location = yield* Location.Service
      const agents = yield* AgentV2.Service
      const registry = yield* ToolRegistry.Service
      const permission = yield* PermissionV2.Service
      const saved = yield* PermissionSaved.Service
      const sessionID = SessionV2.ID.make("ses_permission_real_shell")
      yield* database.db
        .insert(ProjectTable)
        .values({
          id: Project.ID.global,
          worktree: location.directory,
          sandboxes: [],
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* database.db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "permission-real-shell",
          directory: location.directory,
          title: "Permission real shell",
          version: "test",
          agent: "build",
          permission_mode: "full",
        })
        .run()
        .pipe(Effect.orDie)
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "bash", resource: "*", effect: "deny" }]
        }),
      )
      // Hold the same materialization across mode changes. Leaf authorization must stay current.
      const tools = yield* registry.materialize()
      const execute = (value: string) =>
        tools.settle({
          sessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: `call-${value}`,
            name: "bash",
            input: { command: `printf '${value}' > mode-result.txt` },
          },
        })
      const setMode = (permission_mode: "default" | "auto" | "full") =>
        database.db
          .update(SessionTable)
          .set({ permission_mode })
          .where(eq(SessionTable.id, sessionID))
          .run()
          .pipe(Effect.orDie)
      const content = () => Effect.promise(() => Bun.file(path.join(location.directory, "mode-result.txt")).text())

      expect((yield* execute("full")).result.type).toBe("content")
      expect(yield* content()).toBe("full")
      yield* setMode("default")
      expect((yield* execute("default-blocked")).result.type).toBe("error")
      expect(yield* content()).toBe("full")
      yield* setMode("auto")
      expect((yield* execute("auto-blocked")).result.type).toBe("error")
      expect(yield* content()).toBe("full")
      yield* agents.transform((editor) =>
        editor.update(AgentV2.ID.make("build"), (agent) => {
          agent.permissions = [{ action: "bash", resource: "*", effect: "ask" }]
        }),
      )
      expect((yield* execute("auto")).result.type).toBe("content")
      expect(yield* content()).toBe("auto")
      expect(yield* permission.list()).toEqual([])
      expect(yield* saved.list({ projectID: location.project.id })).toEqual([])
    }),
  { timeout: 20_000 },
)
