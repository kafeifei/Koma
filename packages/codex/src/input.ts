import { readFile, stat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { SessionExternal } from "@opencode-ai/schema/session-external"
import type { ReasoningEffort, v2 } from "./protocol/generated/index"

export async function prepareInput(input: SessionExternal.Input): Promise<SessionExternal.Input> {
  if (input.prompt.agents?.length) throw new Error("OpenCode agent references are not Codex skills")
  const files = await Promise.all(
    (input.prompt.files ?? []).map(async (file) => {
      if (file.uri.startsWith("blob:")) throw new Error("Attachments must be uploaded before submitting")
      if (!file.mime.startsWith("image/") || !file.uri.startsWith("file:")) return file
      // Freeze local image bytes before acknowledging durable admission. The
      // composer may discard its attachment after that acknowledgement.
      const path = fileURLToPath(file.uri)
      if ((await stat(path)).size > 20 * 1024 * 1024) throw new Error("Image exceeds the 20 MiB attachment limit")
      const bytes = await readFile(path)
      if (bytes.byteLength > 20 * 1024 * 1024) throw new Error("Image exceeds the 20 MiB attachment limit")
      return { ...file, uri: `data:${file.mime};base64,${bytes.toString("base64")}` }
    }),
  )
  if (!input.prompt.text.trim() && !files.length) throw new Error("Prompt is empty")
  return { ...input, prompt: { ...input.prompt, files: files.length ? files : undefined } }
}

export function codexInput(input: SessionExternal.Input): v2.UserInput[] {
  return [
    ...(input.prompt.text ? [{ type: "text" as const, text: input.prompt.text, text_elements: [] }] : []),
    ...(input.prompt.files ?? []).map((file): v2.UserInput => {
      if (file.mime.startsWith("image/")) return { type: "image", url: file.uri }
      const path = file.uri.startsWith("file:") ? fileURLToPath(file.uri) : file.uri
      return {
        type: "text",
        text: [file.name ? `@${file.name}` : undefined, path, file.description, file.source?.text]
          .filter(Boolean)
          .join("\n"),
        text_elements: [],
      }
    }),
  ]
}

export function threadSettings(
  settings: SessionExternal.Settings,
): Pick<v2.ThreadStartParams, "model" | "sandbox" | "approvalPolicy" | "approvalsReviewer"> {
  if (!settings.permission) return { model: settings.model }
  return {
    model: settings.model,
    sandbox:
      settings.permission === "full"
        ? "danger-full-access"
        : settings.permission === "readOnly"
          ? "read-only"
          : "workspace-write",
    approvalPolicy: settings.permission === "full" ? "never" : "on-request",
    approvalsReviewer: "user",
  }
}

export function turnSettings(
  settings: SessionExternal.Settings,
  cwd: string,
): Pick<v2.TurnStartParams, "model" | "effort" | "sandboxPolicy" | "approvalPolicy" | "approvalsReviewer"> {
  const values = threadSettings(settings)
  return {
    model: values.model,
    effort: settings.effort as ReasoningEffort | undefined,
    approvalPolicy: values.approvalPolicy,
    approvalsReviewer: values.approvalsReviewer,
    sandboxPolicy: !settings.permission
      ? undefined
      : settings.permission === "full"
        ? { type: "dangerFullAccess" }
        : settings.permission === "readOnly"
          ? { type: "readOnly", networkAccess: false }
          : {
              type: "workspaceWrite",
              writableRoots: [cwd],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
  }
}
