import type { Message, Session } from "@opencode-ai/sdk/v2/client"
import { showToast } from "@/utils/toast"
import { base64Encode, checksum } from "@opencode-ai/core/util/encode"
import { Binary } from "@opencode-ai/core/util/binary"
import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { batch, onCleanup, startTransition, type Accessor } from "solid-js"
import { useTabs } from "@/context/tabs"
import { useServerSync, type ServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { useLocal, type ModelSelection } from "@/context/local"
import { type ContextItem, type ImageAttachmentPart, type Prompt, type usePrompt } from "@/context/prompt"
import { useSDK, type DirectorySDK } from "@/context/sdk"
import { useSync, type DirectorySync } from "@/context/sync"
import { Identifier } from "@/utils/id"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { buildRequestParts } from "./build-request-parts"
import { setCursorPosition } from "./editor-dom"
import { formatServerError, PermissionModeError } from "@/utils/server-errors"
import { ScopedKey } from "@/utils/server-scope"
import { createPromptSubmissionState } from "./submission-state"
import { normalizeSessionInfo } from "@/utils/session"
import { Event } from "@opencode-ai/schema/event"
import { blobDataUrl } from "@/utils/draft-store"
import { uuid } from "@/utils/uuid"
import type { PermissionMode } from "@/context/tabs"
import { createPromptSession } from "@/context/prompt-state"

type PendingPrompt = {
  abort: AbortController
  cleanup: VoidFunction
}

type ExternalDescriptor = NonNullable<ServerSync["external"]["data"]["descriptors"][string]>

const pending = new Map<string, PendingPrompt>()

export type FollowupDraft = {
  sessionID: string
  sessionDirectory: string
  prompt: Prompt
  context: (ContextItem & { key: string })[]
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
}

type FollowupSendInput = {
  api: DirectorySDK["api"]["session"]
  serverSync: ServerSync
  sync: DirectorySync
  draft: FollowupDraft
  messageID?: string
  optimisticBusy?: boolean
  before?: () => Promise<boolean> | boolean
}

const draftText = (prompt: Prompt) => prompt.map((part) => ("content" in part ? part.content : "")).join("")

const draftImages = (prompt: Prompt) => prompt.filter((part): part is ImageAttachmentPart => part.type === "image")

const durableExternalDelivery = (state: string) => state === "pending" || state === "sending" || state === "accepted"
const blockedExternalStatus = new Set(["disconnected", "systemError", "bindingUnavailable"])

export function canSubmitExternalDescriptor(
  descriptor: { runtimeStatus: string; capabilities: { prompt: boolean } } | undefined,
) {
  return !!descriptor?.capabilities.prompt && !blockedExternalStatus.has(descriptor.runtimeStatus)
}

const sourceExternalEngine = (sync: ServerSync, sessionID: string) => sync.external.engine(sessionID)

async function resolveExternalEngine(sync: ServerSync, sessionID: string) {
  const current = sourceExternalEngine(sync, sessionID)
  if (current) return current
  await sync.external.describe([sessionID])
  return sourceExternalEngine(sync, sessionID)
}

export async function sendFollowupDraft(input: FollowupSendInput) {
  const text = draftText(input.draft.prompt)
  const images = draftImages(input.draft.prompt)
  const setBusy = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "busy" })
  }

  const setIdle = () => {
    if (!input.optimisticBusy) return
    input.serverSync.session.set("session_status", input.draft.sessionID, { type: "idle" })
  }

  const wait = async () => {
    const ok = await input.before?.()
    if (ok === false) return false
    return true
  }

  const [head, ...tail] = text.split(" ")
  const cmd = head?.startsWith("/") ? head.slice(1) : undefined
  if (cmd && input.sync.data.command.find((item) => item.name === cmd)) {
    setBusy()
    try {
      if (!(await wait())) {
        setIdle()
        return false
      }

      const messageID = Identifier.ascending("message")
      await input.api.command({
        sessionID: input.draft.sessionID,
        id: messageID,
        command: cmd,
        arguments: tail.join(" "),
        agent: input.draft.agent,
        model: {
          id: input.draft.model.modelID,
          providerID: input.draft.model.providerID,
          variant: input.draft.variant,
        },
        files: await Promise.all(
          images.map(async (attachment) => ({
            uri: await blobDataUrl(attachment.blob, attachment.mime),
            name: attachment.filename,
          })),
        ),
      })
      return true
    } catch (err) {
      setIdle()
      throw err
    }
  }

  const messageID = input.messageID ?? Identifier.ascending("message")
  const encodedImages = await Promise.all(
    images.map(async (attachment) => ({
      ...attachment,
      dataUrl: await blobDataUrl(attachment.blob, attachment.mime),
    })),
  )
  const { requestParts, optimisticParts } = buildRequestParts({
    prompt: input.draft.prompt,
    context: input.draft.context,
    images: encodedImages,
    text,
    sessionID: input.draft.sessionID,
    messageID,
    sessionDirectory: input.draft.sessionDirectory,
  })

  const message: Message = {
    id: messageID,
    sessionID: input.draft.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.draft.agent,
    model: { ...input.draft.model, variant: input.draft.variant },
  }

  const add = () =>
    input.sync.session.optimistic.add({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      message,
      parts: optimisticParts,
    })

  const remove = () =>
    input.sync.session.optimistic.remove({
      directory: input.draft.sessionDirectory,
      sessionID: input.draft.sessionID,
      messageID,
    })

  batch(() => {
    setBusy()
    add()
  })

  try {
    if (!(await wait())) {
      batch(() => {
        setIdle()
        remove()
      })
      return false
    }

    await input.api.prompt({
      sessionID: input.draft.sessionID,
      id: messageID,
      agent: input.draft.agent,
      model: input.draft.model,
      variant: input.draft.variant,
      legacyParts: requestParts,
      text: requestParts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
      files: requestParts.flatMap((part) => {
        if (part.type !== "file") return []
        const text = part.source?.text
        return [
          {
            uri: part.url,
            name: part.filename,
            mention: text ? { start: text.start, end: text.end, text: text.value } : undefined,
          },
        ]
      }),
      agents: requestParts.flatMap((part) =>
        part.type === "agent"
          ? [
              {
                name: part.name,
                mention: part.source
                  ? { start: part.source.start, end: part.source.end, text: part.source.value }
                  : undefined,
              },
            ]
          : [],
      ),
    })
    return true
  } catch (err) {
    batch(() => {
      setIdle()
      remove()
    })
    throw err
  }
}

type PromptSubmitInput = {
  prompt: ReturnType<typeof usePrompt>
  info: Accessor<{ id: string } | undefined>
  imageAttachments: Accessor<ImageAttachmentPart[]>
  commentCount: Accessor<number>
  permissionMode: Accessor<PermissionMode>
  mode: Accessor<"normal" | "shell">
  working: Accessor<boolean>
  editor: () => HTMLDivElement | undefined
  queueScroll: () => void
  promptLength: (prompt: Prompt) => number
  addToHistory: (prompt: Prompt, mode: "normal" | "shell") => void
  resetHistoryNavigation: () => void
  setMode: (mode: "normal" | "shell") => void
  setPopover: (popover: "at" | "slash" | null) => void
  newSessionWorktree?: Accessor<string | undefined>
  newSessionBaseBranch?: Accessor<string | undefined>
  newSessionWorktreeReady?: Accessor<boolean>
  onNewSessionWorktreeReset?: () => void
  shouldQueue?: Accessor<boolean>
  onQueue?: (draft: FollowupDraft) => void
  onAbort?: () => void
  onSubmit?: () => void
  model?: ModelSelection
}

export function createPromptSubmit(input: PromptSubmitInput) {
  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const local = useLocal()
  const prompt = input.prompt
  const layout = useLayout()
  const language = useLanguage()
  const params = useParams()
  const [search] = useSearchParams<{ draftId?: string }>()
  const tabs = useTabs()
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const pendingKey = (sessionID: string) => ScopedKey.from(sdk().scope, sessionID)

  const errorMessage = (err: unknown) => {
    if (err instanceof PermissionModeError) return formatServerError(err, language.t)
    if (err && typeof err === "object" && "message" in err && typeof err.message === "string") return err.message
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const abort = async () => {
    const sessionID = params.id
    if (!sessionID) return Promise.resolve()

    const external = sourceExternalEngine(serverSync(), sessionID)
    if (external === "codex")
      return serverSync()
        .external.actions.interrupt(sessionID)
        .then(() => undefined)
    if (!external) {
      return serverSync()
        .external.describe([sessionID])
        .then(async () => {
          if (sourceExternalEngine(serverSync(), sessionID) !== "codex") {
            serverSync().session.set("todo", sessionID, [])
            input.onAbort?.()
            await sdk().api.session.interrupt({ sessionID })
            return
          }
          await serverSync().external.actions.interrupt(sessionID)
        })
        .catch(() => undefined)
    }

    const key = pendingKey(sessionID)
    const queued = pending.get(key)
    if (queued) {
      queued.abort.abort()
      queued.cleanup()
      pending.delete(key)
      return Promise.resolve()
    }
    serverSync().session.set("todo", sessionID, [])
    input.onAbort?.()
    return sdk()
      .api.session.interrupt({ sessionID })
      .catch(() => {})
  }

  const restoreCommentItems = (
    target: ReturnType<ReturnType<typeof usePrompt>["capture"]>,
    items: (ContextItem & { key: string })[],
  ) => {
    for (const item of items) {
      target.context.add({
        type: "file",
        path: item.path,
        selection: item.selection,
        comment: item.comment,
        commentID: item.commentID,
        commentOrigin: item.commentOrigin,
        preview: item.preview,
      })
    }
  }

  const clearContext = (target: ReturnType<ReturnType<typeof usePrompt>["capture"]>) => {
    for (const item of target.context.items()) {
      target.context.remove(item.key)
    }
  }

  const seed = (source: ServerSync, dir: string, info: Session) => {
    source.session.remember(info)
    const [, setStore] = source.child(dir)
    setStore("session", (list: Session[]) => {
      const result = Binary.search(list, info.id, (item) => item.id)
      const next = [...list]
      if (result.found) {
        next[result.index] = info
        return next
      }
      next.splice(result.index, 0, info)
      return next
    })
  }

  const creation = new WeakSet<object>()
  const submit = async (event: Event) => {
    event.preventDefault()

    const target = prompt.capture()
    const sourceSDK = sdk()
    const sourceSync = sync()
    const sourceServerSync = serverSync()
    const draftID = search.draftId
    const draftServer = draftID ? tabs.draft(draftID).server : undefined
    const active = () => !disposed && prompt.capture() === target
    const submission = createPromptSubmissionState({
      target,
      prompt: target.current(),
      context: target.context.items().slice(),
    })
    const currentPrompt = submission.prompt
    const context = submission.context
    const text = currentPrompt.map((part) => ("content" in part ? part.content : "")).join("")
    const images = input.imageAttachments().slice()
    const mode = input.mode()
    const codexPreferences = { ...target.codex.current() }
    const codexPreferenceRevision = target.codex.revision()

    if (text.trim().length === 0 && images.length === 0 && input.commentCount() === 0) {
      if (input.working()) void abort()
      return
    }

    if (!params.id && input.newSessionWorktreeReady?.() === false) {
      showToast({ title: language.t("prompt.toast.worktreeNotReady.title") })
      return
    }

    const existingID = params.id
    const isNewSession = !existingID
    const engine = isNewSession
      ? target.engine.current()
      : await resolveExternalEngine(sourceServerSync, existingID).catch((err) => {
          showToast({
            title: language.t("prompt.toast.engineUnavailable.title"),
            description: errorMessage(err),
          })
          return undefined
        })
    if (!engine) return

    let externalDescriptor: ExternalDescriptor | undefined
    let externalDesiredSettings: ExternalDescriptor["settings"] | undefined
    if (engine === "codex") {
      if (isNewSession) {
        const engines =
          sourceServerSync.external.data.engines ??
          (await sourceServerSync.external.refreshEngines().catch((err) => {
            showToast({ title: language.t("prompt.toast.codexUnavailable.title"), description: errorMessage(err) })
            return undefined
          }))
        const codex = engines?.find((item) => item.id === "codex")
        if (!codex?.available || !codex.capabilities.prompt) {
          showToast({
            title: language.t("prompt.toast.codexUnavailable.title"),
            description: codex?.error ?? language.t("prompt.toast.codexUnavailable.description"),
          })
          return
        }
      }
      if (!isNewSession) {
        externalDescriptor =
          sourceServerSync.external.data.descriptors[existingID!] ??
          (await sourceServerSync.external
            .describe([existingID!])
            .then(() => sourceServerSync.external.data.descriptors[existingID!])
            .catch((err) => {
              showToast({ title: language.t("prompt.toast.codexUnavailable.title"), description: errorMessage(err) })
              return undefined
            }))
        if (!externalDescriptor || !canSubmitExternalDescriptor(externalDescriptor)) {
          showToast({
            title: language.t("prompt.toast.codexUnavailable.title"),
            description: externalDescriptor?.error ?? language.t("prompt.toast.codexUnavailable.description"),
          })
          return
        }
        externalDesiredSettings = { ...externalDescriptor.settings, ...externalDescriptor.pendingSettings }
      }
    }

    const customCommand = text.startsWith("/")
      ? sourceSync.data.command.find((command) => command.name === text.split(" ")[0].slice(1))
      : undefined
    if (
      engine === "codex" &&
      (mode === "shell" || !!customCommand || currentPrompt.some((part) => part.type === "agent"))
    ) {
      showToast({
        title: language.t("prompt.toast.codexUnsupported.title"),
        description: language.t("prompt.toast.codexUnsupported.description"),
      })
      return
    }

    const modelSelection = input.model ?? local.model
    const currentModel = modelSelection.current()
    const currentAgent = local.agent.current()
    const variant = modelSelection.variant.current()
    if (engine === "opencode" && (!currentModel || !currentAgent)) {
      showToast({
        title: language.t("prompt.toast.modelAgentRequired.title"),
        description: language.t("prompt.toast.modelAgentRequired.description"),
      })
      return
    }

    input.addToHistory(currentPrompt, mode)
    input.resetHistoryNavigation()

    const projectDirectory = sourceSDK.directory
    const permissionMode = isNewSession ? input.permissionMode() : undefined
    const worktreeSelection = input.newSessionWorktree?.() || "main"

    let sessionDirectory = projectDirectory
    let client = sourceSDK.client
    let session = input.info()

    if (isNewSession) {
      if (worktreeSelection === "create") {
        const createdWorktree = await client.worktree
          .create({
            directory: projectDirectory,
            worktreeCreateInput: { baseBranch: input.newSessionBaseBranch?.(), wait: true },
          })
          .then((x) => x.data)
          .catch((err) => {
            showToast({
              title: language.t("prompt.toast.worktreeCreateFailed.title"),
              description: errorMessage(err),
            })
            return undefined
          })

        if (!createdWorktree?.directory) {
          showToast({
            title: language.t("prompt.toast.worktreeCreateFailed.title"),
            description: language.t("common.requestFailed"),
          })
          return
        }
        // The wait response is authoritative even if the global ready event preceded this request's subscription.
        WorktreeState.ready(sourceSDK.scope, createdWorktree.directory)
        sessionDirectory = createdWorktree.directory
      }

      if (worktreeSelection !== "main" && worktreeSelection !== "create") {
        sessionDirectory = worktreeSelection
      }

      if (sessionDirectory !== projectDirectory) {
        client = sourceSDK.createClient({
          directory: sessionDirectory,
          throwOnError: true,
        })
        sourceServerSync.child(sessionDirectory)
      }

      if (active()) input.onNewSessionWorktreeReset?.()
    }

    if (engine === "codex") {
      const encodedImages = await Promise.all(
        images.map(async (attachment) => ({
          ...attachment,
          dataUrl: await blobDataUrl(attachment.blob, attachment.mime),
        })),
      )
      const { requestParts } = buildRequestParts({
        prompt: currentPrompt,
        context,
        images: encodedImages,
        text,
        sessionID: params.id ?? "pending",
        messageID: Identifier.ascending("message"),
        sessionDirectory,
      })
      const externalPrompt = {
        text: requestParts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
        files: requestParts.flatMap((part) => {
          if (part.type !== "file") return []
          const source = part.source?.text
          return [
            {
              uri: part.url,
              mime: part.mime,
              name: part.filename,
              source: source ? { start: source.start, end: source.end, text: source.value } : undefined,
            },
          ]
        }),
      }
      const requestedDelivery = !isNewSession && input.shouldQueue?.() ? ("queue" as const) : ("steer" as const)
      const serialized = JSON.stringify({
        directory: sessionDirectory,
        prompt: externalPrompt,
        codexPreferenceRevision,
      })
      const fingerprint = checksum(serialized) ?? serialized
      const remembered = target.externalRequest.current()
      const delivery =
        remembered?.fingerprint === fingerprint ? (remembered.delivery ?? requestedDelivery) : requestedDelivery
      const desiredSettings = externalDesiredSettings ?? codexPreferences
      const settings =
        remembered?.fingerprint === fingerprint ? (remembered.settings ?? desiredSettings) : desiredSettings
      const request =
        remembered?.fingerprint === fingerprint
          ? remembered
          : {
              requestID: uuid(),
              fingerprint,
              operation: isNewSession ? ("create" as const) : ("submit" as const),
              delivery,
              settings,
            }
      target.externalRequest.set(request)
      const externalInput = { prompt: externalPrompt, settings }

      const prior =
        remembered?.fingerprint === fingerprint && existingID
          ? await sourceServerSync.external.actions
              .delivery({ sessionID: existingID, requestID: request.requestID })
              .catch(() => undefined)
          : undefined
      const accepted = await (
        prior && prior.state !== "unknown"
          ? Promise.resolve({ descriptor: sourceServerSync.external.data.descriptors[existingID!]!, delivery: prior })
          : request.operation === "create"
            ? sourceServerSync.external.actions.create({
                requestID: request.requestID,
                engine: "codex",
                location: { directory: sessionDirectory },
                input: externalInput,
                delivery,
              })
            : sourceServerSync.external.actions.submit({
                sessionID: existingID!,
                requestID: request.requestID,
                input: externalInput,
                delivery,
              })
      ).catch((err) => {
        showToast({
          title: language.t("prompt.toast.promptSendFailed.title"),
          description: errorMessage(err),
        })
        return undefined
      })
      if (!accepted) return

      const createdSession = isNewSession || request.operation === "create"
      if (createdSession) {
        const resolved = await sourceServerSync.session.resolve(accepted.descriptor.sessionID).catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
        if (!resolved) return
        seed(sourceServerSync, sessionDirectory, resolved)
        const scope = { dir: base64Encode(sessionDirectory), id: resolved.id }
        const destination = draftServer
          ? tabs.state({ type: "session", server: draftServer, sessionId: resolved.id }, "prompt", () =>
              createPromptSession(sourceSDK.scope, scope),
            )
          : undefined
        if (destination) await destination.ready.promise
        const latestSettings = target.codex.current()
        const latestRevision = target.codex.revision()
        submission.retarget(destination?.capture() ?? prompt.capture(scope))
        submission.target().engine.set("codex")
        submission.target().codex.set(latestSettings, { revision: latestRevision })
        submission.target().externalRequest.set(request)
        await startTransition(() => {
          if (active()) layout.handoff.setTabs(base64Encode(sessionDirectory), resolved.id)
          if (draftID && draftServer)
            tabs.promoteDraft(
              draftID,
              { server: draftServer, sessionId: resolved.id },
              active() && target.current() === currentPrompt,
            )
          else if (active()) navigate(`/${base64Encode(sessionDirectory)}/session/${resolved.id}`)
        })
      }

      if (durableExternalDelivery(accepted.delivery.state)) {
        if (target.externalRequest.current()?.requestID === request.requestID) target.externalRequest.set(undefined)
        if (submission.target().externalRequest.current()?.requestID === request.requestID)
          submission.target().externalRequest.set(undefined)
        const preferencesUnchanged = submission.target().codex.revision() === codexPreferenceRevision
        if (preferencesUnchanged) submission.clearContext()
        const cleared = preferencesUnchanged ? submission.clear() : false
        if (!preferencesUnchanged && createdSession) submission.preserve()
        if (cleared && !disposed && submission.current(prompt.capture())) {
          input.setMode("normal")
          input.setPopover(null)
          input.onSubmit?.()
        }
        return
      }

      if (accepted.delivery.state !== "unknown") {
        if (target.externalRequest.current()?.requestID === request.requestID) target.externalRequest.set(undefined)
        if (submission.target().externalRequest.current()?.requestID === request.requestID)
          submission.target().externalRequest.set(undefined)
      }
      if (createdSession) submission.preserve()
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: accepted.delivery.error ?? language.t("common.requestFailed"),
      })
      return
    }

    if (!session && isNewSession) {
      const created = await sourceSDK.api.session
        .create({
          agent: currentAgent!.name,
          model: { id: currentModel!.id, providerID: currentModel!.provider.id, variant },
          permissionMode,
          location: { directory: sessionDirectory },
        })
        .then(normalizeSessionInfo)
        .then((session) => {
          if (permissionMode === "default" || session.permissionMode === permissionMode) return session
          throw new PermissionModeError()
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.sessionCreateFailed.title"),
            description: errorMessage(err),
          })
          return undefined
        })
      if (created) {
        seed(sourceServerSync, sessionDirectory, created)
        session = created
        const scope = { dir: base64Encode(sessionDirectory), id: created.id }
        const destination = draftServer
          ? tabs.state({ type: "session", server: draftServer, sessionId: created.id }, "prompt", () =>
              createPromptSession(sourceSDK.scope, scope),
            )
          : undefined
        if (destination) await destination.ready.promise
        submission.retarget(destination?.capture() ?? prompt.capture(scope))
        await startTransition(() => {
          if (!session) return
          local.session.promote(sessionDirectory, session.id, {
            agent: currentAgent!.name,
            model: { providerID: currentModel!.provider.id, modelID: currentModel!.id },
            variant: variant ?? null,
          })
          if (active()) layout.handoff.setTabs(base64Encode(sessionDirectory), session.id)
          if (draftID && draftServer)
            tabs.promoteDraft(
              draftID,
              { server: draftServer, sessionId: session.id },
              active() && target.current() === currentPrompt,
            )
          else if (active()) navigate(`/${base64Encode(sessionDirectory)}/session/${session.id}`)
        })
      }
    }
    if (!session) {
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: language.t("prompt.toast.promptSendFailed.description"),
      })
      return
    }

    const model = {
      modelID: currentModel!.id,
      providerID: currentModel!.provider.id,
    }
    const agent = currentAgent!.name
    const draft: FollowupDraft = {
      sessionID: session.id,
      sessionDirectory,
      prompt: currentPrompt,
      context,
      agent,
      model,
      variant,
    }

    const clearInput = () => {
      submission.clear()
      if (disposed || !submission.current(prompt.capture())) return
      input.setMode("normal")
      input.setPopover(null)
    }

    const restoreInput = () => {
      const restored = submission.restore()
      if (!restored) return false
      restored.target.set(restored.prompt, input.promptLength(restored.prompt))
      if (disposed || !submission.current(prompt.capture())) return true
      input.setMode(mode)
      input.setPopover(null)
      requestAnimationFrame(() => {
        const editor = input.editor()
        if (!editor) return
        editor.focus()
        setCursorPosition(editor, input.promptLength(currentPrompt))
        input.queueScroll()
      })
      return true
    }

    if (!isNewSession && mode === "normal" && input.shouldQueue?.()) {
      input.onQueue?.(draft)
      clearContext(submission.target())
      clearInput()
      return
    }

    if (active() && target.current() === currentPrompt) input.onSubmit?.()

    if (mode === "shell") {
      clearInput()
      const eventID = Event.ID.create()
      sourceSDK.api.session
        .shell({
          sessionID: session.id,
          id: eventID,
          command: text,
          agent,
          model,
        })
        .catch((err) => {
          showToast({
            title: language.t("prompt.toast.shellSendFailed.title"),
            description: errorMessage(err),
          })
          restoreInput()
        })
      return
    }

    if (text.startsWith("/")) {
      const [cmdName, ...args] = text.split(" ")
      const commandName = cmdName.slice(1)
      const customCommand = sourceSync.data.command.find((c) => c.name === commandName)
      if (customCommand) {
        clearInput()
        const messageID = Identifier.ascending("message")
        sourceServerSync.session.set("session_status", session.id, { type: "busy" })
        sourceSDK.api.session
          .command({
            sessionID: session.id,
            id: messageID,
            command: commandName,
            arguments: args.join(" "),
            agent,
            model: { id: model.modelID, providerID: model.providerID, variant },
            files: await Promise.all(
              images.map(async (attachment) => ({
                uri: await blobDataUrl(attachment.blob, attachment.mime),
                name: attachment.filename,
              })),
            ),
          })
          .catch((err) => {
            sourceServerSync.session.set("session_status", session.id, { type: "idle" })
            showToast({
              title: language.t("prompt.toast.commandSendFailed.title"),
              description: formatServerError(err, language.t, language.t("common.requestFailed")),
            })
            restoreInput()
          })
        return
      }
    }

    const commentItems = context.filter((item) => item.type === "file" && !!item.comment?.trim())
    const messageID = Identifier.ascending("message")

    const removeOptimisticMessage = () => {
      sourceSync.session.optimistic.remove({
        directory: sessionDirectory,
        sessionID: session.id,
        messageID,
      })
    }

    for (const item of commentItems) submission.target().context.remove(item.key)
    clearInput()

    const waitForWorktree = async () => {
      const worktree = WorktreeState.get(sourceSDK.scope, sessionDirectory)
      if (!worktree || worktree.status !== "pending") return true

      if (sessionDirectory === projectDirectory) {
        sourceSync.set("session_status", session.id, { type: "busy" })
      }

      const controller = new AbortController()
      const cleanup = () => {
        if (sessionDirectory === projectDirectory) {
          sourceSync.set("session_status", session.id, { type: "idle" })
        }
        removeOptimisticMessage()
        if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
      }

      pending.set(ScopedKey.from(sourceSDK.scope, session.id), { abort: controller, cleanup })

      const abortWait = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        if (controller.signal.aborted) {
          resolve({ status: "failed", message: "aborted" })
          return
        }
        controller.signal.addEventListener(
          "abort",
          () => {
            resolve({ status: "failed", message: "aborted" })
          },
          { once: true },
        )
      })

      const timeoutMs = 5 * 60 * 1000
      const timer = { id: undefined as number | undefined }
      const timeout = new Promise<Awaited<ReturnType<typeof WorktreeState.wait>>>((resolve) => {
        timer.id = window.setTimeout(() => {
          resolve({
            status: "failed",
            message: language.t("workspace.error.stillPreparing"),
          })
        }, timeoutMs)
      })

      const result = await Promise.race([
        WorktreeState.wait(sourceSDK.scope, sessionDirectory),
        abortWait,
        timeout,
      ]).finally(() => {
        if (timer.id === undefined) return
        clearTimeout(timer.id)
      })
      pending.delete(ScopedKey.from(sourceSDK.scope, session.id))
      if (controller.signal.aborted) return false
      if (result.status === "failed") throw new Error(result.message)
      return true
    }

    void sendFollowupDraft({
      api: sourceSDK.api.session,
      sync: sourceSync,
      serverSync: sourceServerSync,
      draft,
      messageID,
      optimisticBusy: sessionDirectory === projectDirectory,
      before: waitForWorktree,
    }).catch((err) => {
      pending.delete(ScopedKey.from(sourceSDK.scope, session.id))
      if (sessionDirectory === projectDirectory) {
        sourceSync.set("session_status", session.id, { type: "idle" })
      }
      showToast({
        title: language.t("prompt.toast.promptSendFailed.title"),
        description: errorMessage(err),
      })
      removeOptimisticMessage()
      if (restoreInput()) restoreCommentItems(submission.target(), commentItems)
    })
  }

  return {
    abort,
    handleSubmit: (event: Event) => {
      event.preventDefault()
      if (params.id) return submit(event)
      const target = prompt.capture()
      if (creation.has(target)) return Promise.resolve()
      creation.add(target)
      return submit(event).finally(() => {
        creation.delete(target)
      })
    },
  }
}
