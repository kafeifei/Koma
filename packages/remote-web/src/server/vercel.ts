import type { IncomingMessage, ServerResponse } from "node:http"
import { handleNodeRequest } from "./node.ts"

export default function handler(request: IncomingMessage, response: ServerResponse) {
  return handleNodeRequest(request, response)
}
