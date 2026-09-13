import { afterAll, expect } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Effect, Exit } from "effect"
import { Global } from "@opencode-ai/core/global"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { save, COMPUTER_USE_SERVER } from "@opencode-ai/core/koma-computer-use"
import { MCP } from "../../src/mcp"
import { McpCatalog } from "../../src/mcp/catalog"
import { testEffect } from "../lib/effect"

const root = await mkdtemp(join(tmpdir(), "koma-mcp-"))
afterAll(() => rm(root, { recursive: true, force: true }))
const binary = join(root, "cua-driver")
await writeFile(
  binary,
  `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(join(import.meta.dir, "../fixture/mcp-computer-use.ts")).href)}\n`,
  { mode: 0o700 },
)
const it = testEffect(LayerNode.compile(MCP.node, [[Global.node, Global.layerWith({ root })]]))

it.instance(
  "managed desktop tools connect on demand, preserve image blocks, and disable without disturbing other MCPs",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* Effect.promise(() => save(root, true, binary))
      expect((yield* mcp.status())[COMPUTER_USE_SERVER]?.status).toBe("disabled")
      const key = McpCatalog.toolName(COMPUTER_USE_SERVER, "observe")
      const tools = yield* mcp.tools()
      expect(tools[key]).toBeDefined()
      const observed = yield* Effect.promise(() => tools[key]!.client.callTool({ name: "observe", arguments: {} }))
      expect(observed.content).toEqual([{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }])
      expect(Exit.isFailure(yield* Effect.exit(mcp.remove(COMPUTER_USE_SERVER)))).toBe(true)
      expect((yield* mcp.tools())[key]).toBeDefined()
      yield* mcp.add("personal", { type: "local", command: [binary], enabled: true })
      yield* Effect.promise(() => save(root, false, binary))
      const remaining = yield* mcp.tools()
      expect(remaining[key]).toBeUndefined()
      expect(remaining[McpCatalog.toolName("personal", "observe")]).toBeDefined()
      expect((yield* mcp.status())[COMPUTER_USE_SERVER]?.status).toBe("disabled")
    }),
  { config: {} },
)
