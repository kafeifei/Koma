/** Presentation aliases preserve the original tool identity and inspectable input. */
export function toolPresentationName(name: string) {
  if (name === "bash" || name === "codex.commandExecution") return "shell"
  if (name === "apply_patch" || name === "codex.fileChange") return "patch"
  if (name === "codex.webSearch") return "websearch"
  if (name === "codex.subagent") return "task"
  return name
}
