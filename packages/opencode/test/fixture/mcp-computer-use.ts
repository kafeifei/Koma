import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const server = new Server({ name: "computer-use-fixture", version: "1.0" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "observe", description: "Observe the fixture", inputSchema: { type: "object", properties: {} } }],
}))
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
}))
await server.connect(new StdioServerTransport())
