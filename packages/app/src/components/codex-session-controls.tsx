import type { JsonValue, LabSnapshotOutput } from "@opencode-ai/lab-client"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { DockTray } from "@opencode-ai/ui/dock-surface"
import { Icon } from "@opencode-ai/ui/icon"
import { DockPrompt } from "@opencode-ai/session-ui/dock-prompt"
import { TextField } from "@opencode-ai/ui/text-field"
import { createEffect, createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSync } from "@/context/server-sync"
import { SessionTodoDock } from "@/pages/session/composer/session-todo-dock"
import { showToast } from "@/utils/toast"

type Interaction = LabSnapshotOutput["interactions"][number]
type Delivery = LabSnapshotOutput["deliveries"][number]
export type CodexDelivery = Delivery

export function isConfirmedCodexDelivery(delivery: Pick<Delivery, "state" | "nativeItemID">) {
  return delivery.state === "accepted" && !!delivery.nativeItemID
}

export function needsCodexDeliveryConfirmation(delivery: Pick<Delivery, "state" | "nativeItemID">) {
  return delivery.state === "accepted" && !delivery.nativeItemID
}

export function isCodexDeliveryActive(runtimeStatus: string | undefined) {
  return (
    runtimeStatus === "resolving" ||
    runtimeStatus === "creating" ||
    runtimeStatus === "active" ||
    runtimeStatus === "waitingApproval" ||
    runtimeStatus === "waitingInput" ||
    runtimeStatus === "interrupting"
  )
}

export function actionableCodexDeliveries(deliveries: readonly Delivery[]) {
  return deliveries.filter(
    (delivery) =>
      (delivery.state === "accepted" && !isConfirmedCodexDelivery(delivery)) ||
      ["pending", "paused", "sending", "unknown", "returned", "rejected"].includes(delivery.state),
  )
}

export function codexSessionInteractionBlocked(snapshot: LabSnapshotOutput | undefined) {
  if (!snapshot || !["waitingApproval", "waitingInput"].includes(snapshot.descriptor.runtimeStatus)) return false
  return snapshot.interactions.some((interaction) => interaction.state === "pending")
}

type FormOption = { label: string; value: string }
export type CodexFormField = {
  name: string
  title: string
  description?: string
  type: "string" | "number" | "integer" | "boolean" | "array"
  required: boolean
  options?: FormOption[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  defaultValue?: string | boolean | string[]
}

type FormValue = string | boolean | string[]

export function codexFormFields(schema: unknown): CodexFormField[] | undefined {
  if (!record(schema) || schema.type !== "object" || !record(schema.properties)) return undefined
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((item) => typeof item === "string") : [],
  )
  const fields = Object.entries(schema.properties).flatMap(([name, value]) => {
    if (!record(value) || !formType(value.type)) return []
    const type = value.type
    const options = formOptions(value)
    const defaultValue = formDefault(type, value.default)
    return [
      {
        name,
        title: typeof value.title === "string" ? value.title : name,
        description: typeof value.description === "string" ? value.description : undefined,
        type,
        required: required.has(name),
        options,
        minimum: finite(value.minimum),
        maximum: finite(value.maximum),
        minLength: integer(value.minLength),
        maxLength: integer(value.maxLength),
        minItems: integer(value.minItems),
        maxItems: integer(value.maxItems),
        defaultValue,
      },
    ]
  })
  if (fields.length !== Object.keys(schema.properties).length) return undefined
  return fields
}

export function codexFormContent(fields: readonly CodexFormField[], values: Record<string, FormValue | undefined>) {
  const content: Record<string, string | number | boolean | string[]> = {}
  for (const field of fields) {
    const value =
      values[field.name] ?? field.defaultValue ?? (field.type === "boolean" ? false : field.type === "array" ? [] : "")
    if (field.type === "boolean") {
      content[field.name] = value === true
      continue
    }
    if (field.type === "array") {
      const selected = Array.isArray(value) ? value : []
      if (field.required && !selected.length) return undefined
      if (field.minItems !== undefined && selected.length < field.minItems) return undefined
      if (field.maxItems !== undefined && selected.length > field.maxItems) return undefined
      if (field.options && selected.some((item) => !field.options!.some((option) => option.value === item)))
        return undefined
      content[field.name] = selected
      continue
    }
    const text = typeof value === "string" ? value : ""
    if (field.required && !text.length) return undefined
    if (field.type === "string") {
      if (field.minLength !== undefined && text.length < field.minLength) return undefined
      if (field.maxLength !== undefined && text.length > field.maxLength) return undefined
      if (field.options && text && !field.options.some((option) => option.value === text)) return undefined
      content[field.name] = text
      continue
    }
    if (!text.length && !field.required) continue
    const number = Number(text)
    if (!Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number))) return undefined
    if (field.minimum !== undefined && number < field.minimum) return undefined
    if (field.maximum !== undefined && number > field.maximum) return undefined
    content[field.name] = number
  }
  return content
}

export function CodexSessionControls(props: {
  sessionID?: string
  engine?: "opencode" | "codex"
  onCopyDeliveryText?: (delivery: CodexDelivery) => void
  canCopyDeliveryText?: () => boolean
}) {
  const serverSync = useServerSync()
  const platform = usePlatform()
  const language = useLanguage()
  const [store, setStore] = createStore({
    busy: {} as Record<string, boolean | undefined>,
    errors: {} as Record<string, string | undefined>,
    answers: {} as Record<string, Record<string, string[] | undefined> | undefined>,
    other: {} as Record<string, Record<string, string | undefined> | undefined>,
    forms: {} as Record<string, Record<string, FormValue | undefined> | undefined>,
    planCollapsed: false,
  })

  const external = createMemo(() => serverSync().external)
  const descriptor = createMemo(() => (props.sessionID ? external().data.descriptors[props.sessionID] : undefined))
  const snapshot = createMemo(() => (props.sessionID ? external().data.snapshots[props.sessionID] : undefined))
  const engine = createMemo(() => external().data.engines?.find((item) => item.id === "codex"))
  const visible = createMemo(() => props.engine === "codex" || descriptor()?.engine === "codex")

  const fail = (key: string, error: unknown) => {
    const message = errorMessage(error)
    setStore("errors", key, message)
    showToast({ title: language.t("common.requestFailed"), description: message })
  }

  const refresh = async (sessionID: string) => {
    await external()
      .load(sessionID, { force: true })
      .catch(() => undefined)
  }

  const run = async (key: string, sessionID: string | undefined, action: () => Promise<unknown>) => {
    if (store.busy[key]) return
    setStore("busy", key, true)
    setStore("errors", key, undefined)
    try {
      await action()
    } catch (error) {
      if (sessionID) await refresh(sessionID)
      fail(key, error)
    } finally {
      setStore("busy", key, false)
    }
  }

  createEffect(() => {
    const sessionID = props.sessionID
    if (!visible() || !sessionID) return
    void external()
      .load(sessionID)
      .catch((error) => fail("snapshot", error))
  })

  const interactionReply = (
    interaction: Interaction,
    input: { choiceID?: string; answers?: Record<string, string[]>; content?: JsonValue },
  ) =>
    void run(`interaction:${interaction.id}`, interaction.sessionID, () =>
      external().actions.reply({
        sessionID: interaction.sessionID,
        interactionID: interaction.id,
        revision: interaction.revision,
        ...input,
      }),
    )

  const queue = (action: "resume" | "withdraw", delivery: Delivery) => {
    const current = descriptor()
    if (!current) return
    void run(`delivery:${delivery.requestID}`, delivery.sessionID, () =>
      external().actions.queue({
        sessionID: delivery.sessionID,
        action,
        requestID: delivery.requestID,
        revision: current.revision,
      }),
    )
  }

  const checkDelivery = (delivery: Delivery) =>
    void run(`delivery:${delivery.requestID}`, delivery.sessionID, () =>
      external()
        .actions.delivery({ sessionID: delivery.sessionID, requestID: delivery.requestID })
        .then(() => external().load(delivery.sessionID, { force: true })),
    )

  const deliveries = createMemo(() => actionableCodexDeliveries(snapshot()?.deliveries ?? []))
  const pendingQueue = createMemo(() =>
    snapshot()?.deliveries.find((item) => item.delivery === "queue" && item.state === "pending"),
  )
  const interactions = createMemo(() => snapshot()?.interactions.filter((item) => item.state === "pending") ?? [])
  const plan = createMemo(() => {
    const current = snapshot()?.plan
    return current?.status === "available" ? current.value : undefined
  })
  const controlError = createMemo(
    () => engine()?.error || descriptor()?.error || external().data.errors[props.sessionID ?? ""],
  )
  const queuePaused = createMemo(() => descriptor()?.queuePaused === true)
  const recoveryError = createMemo(() => controlError() || store.errors.snapshot || store.errors.recovery)
  const planTodos = createMemo(() =>
    (plan()?.steps ?? []).map((step) => ({
      content: step.step,
      status: step.status === "inProgress" ? "in_progress" : step.status,
      priority: "medium",
    })),
  )
  const actionable = createMemo(
    () =>
      visible() &&
      (!!recoveryError() || interactions().length > 0 || deliveries().length > 0 || planTodos().length > 0),
  )

  const retry = () =>
    void run("recovery", props.sessionID, async () => {
      await external().refreshEngines()
      if (props.sessionID) await external().load(props.sessionID, { force: true })
    })

  const choiceLabel = (choice: Interaction["choices"][number]) => {
    if (choice.label) return choice.label
    if (choice.kind === "allow") return language.t("codex.interaction.choice.allow")
    if (choice.kind === "allowSession") return language.t("codex.interaction.choice.allowSession")
    if (choice.kind === "deny") return language.t("codex.interaction.choice.deny")
    if (choice.kind === "cancel") return language.t("codex.interaction.choice.cancel")
    return language.t("codex.interaction.choice.custom")
  }

  const answer = (interactionID: string, questionID: string) => store.answers[interactionID]?.[questionID] ?? []
  const setAnswer = (interactionID: string, questionID: string, value: string[]) =>
    setStore("answers", interactionID, (current) => ({ ...current, [questionID]: value }))
  const other = (interactionID: string, questionID: string) => store.other[interactionID]?.[questionID] ?? ""
  const setOther = (interactionID: string, questionID: string, value: string) =>
    setStore("other", interactionID, (current) => ({ ...current, [questionID]: value }))
  const questionAnswers = (interaction: Interaction) =>
    Object.fromEntries(
      (interaction.questions ?? []).map((question) => {
        const raw = other(interaction.id, question.id)
        const custom = question.secret ? raw : raw.trim()
        const selected = answer(interaction.id, question.id)
        return [question.id, custom && !selected.includes(custom) ? [...selected, custom] : selected]
      }),
    )
  const questionsReady = (interaction: Interaction) =>
    Object.values(questionAnswers(interaction)).every((items) => items.length > 0)

  const formValue = (interactionID: string, field: CodexFormField): FormValue =>
    store.forms[interactionID]?.[field.name] ??
    field.defaultValue ??
    (field.type === "boolean" ? false : field.type === "array" ? [] : "")
  const setFormValue = (interactionID: string, name: string, value: FormValue) =>
    setStore("forms", interactionID, (current) => ({ ...current, [name]: value }))

  const deliveryState = (delivery: Delivery) => {
    if (delivery.state === "pending") return language.t("codex.delivery.pending")
    if (delivery.state === "paused") return language.t("codex.queue.paused")
    if (delivery.state === "returned") return language.t("codex.delivery.returned")
    if (delivery.state === "sending") return language.t("codex.delivery.sending")
    if (delivery.state === "accepted") return language.t("codex.delivery.accepted")
    if (delivery.state === "unknown") return language.t("codex.delivery.unknown")
    if (delivery.state === "rejected") return language.t("codex.delivery.rejected")
    return language.t("codex.delivery.withdrawn")
  }

  const deliveryHint = (delivery: Delivery) => {
    if (delivery.state === "returned") return language.t("codex.delivery.returnedHint")
    if (delivery.waitReason === "paused") return language.t("codex.delivery.pausedHint")
    if (delivery.waitReason === "earlierInput") return language.t("codex.delivery.waitEarlier")
    if (delivery.waitReason === "waitingApproval") return language.t("codex.runtime.waitingApproval")
    if (delivery.waitReason === "waitingInput") return language.t("codex.runtime.waitingInput")
    if (delivery.waitReason === "waitingForIdle") return language.t("codex.delivery.waitIdle")
    if (delivery.waitReason === "waitingForConfiguration") return language.t("codex.delivery.waitSettings")
    if (!needsCodexDeliveryConfirmation(delivery)) return undefined
    const status = descriptor()?.runtimeStatus
    if (isCodexDeliveryActive(status) && status !== "interrupting")
      return language.t("codex.delivery.unconfirmedActiveHint")
    return language.t("codex.delivery.unconfirmedHint")
  }

  function ChoiceButtons(interaction: Interaction, options?: { content?: JsonValue; disableAllow?: boolean }) {
    return (
      <div class="flex flex-wrap gap-2">
        <For each={interaction.choices}>
          {(choice) => (
            <Button
              data-choice-id={choice.id}
              size="small"
              variant={choice.kind === "allow" || choice.kind === "allowSession" ? "primary" : "secondary"}
              disabled={
                store.busy[`interaction:${interaction.id}`] ||
                (!!options?.disableAllow && (choice.kind === "allow" || choice.kind === "allowSession"))
              }
              onClick={() =>
                interactionReply(interaction, {
                  choiceID: choice.id,
                  ...(choice.kind === "allow" && options?.content !== undefined ? { content: options.content } : {}),
                })
              }
            >
              {choiceLabel(choice)}
            </Button>
          )}
        </For>
      </div>
    )
  }

  function QuestionInteraction(interaction: Interaction) {
    return (
      <div class="flex flex-col gap-3">
        <For each={interaction.questions ?? []}>
          {(question) => (
            <fieldset class="flex flex-col gap-2">
              <legend class="text-12-medium text-text-base">{question.header}</legend>
              <div class="text-12-regular text-text-weak">{question.question}</div>
              <For each={question.options ?? []}>
                {(option) => (
                  <Checkbox
                    checked={answer(interaction.id, question.id).includes(option.label)}
                    onChange={(checked) => {
                      const current = answer(interaction.id, question.id)
                      if (!question.multiple && checked) setOther(interaction.id, question.id, "")
                      setAnswer(
                        interaction.id,
                        question.id,
                        question.multiple
                          ? checked
                            ? [...current, option.label]
                            : current.filter((item) => item !== option.label)
                          : checked
                            ? [option.label]
                            : [],
                      )
                    }}
                    description={option.description}
                  >
                    {option.label}
                  </Checkbox>
                )}
              </For>
              <Show when={question.allowOther || !(question.options?.length ?? 0)}>
                <TextField
                  type={question.secret ? "password" : "text"}
                  label={question.allowOther ? language.t("codex.question.other") : question.header}
                  hideLabel={!question.allowOther}
                  placeholder={language.t("codex.question.placeholder")}
                  value={other(interaction.id, question.id)}
                  disabled={store.busy[`interaction:${interaction.id}`]}
                  onChange={(value) => {
                    if (!question.multiple && value) setAnswer(interaction.id, question.id, [])
                    setOther(interaction.id, question.id, value)
                  }}
                />
              </Show>
            </fieldset>
          )}
        </For>
      </div>
    )
  }

  function FormInteraction(interaction: Interaction) {
    const fields = createMemo(() => codexFormFields(interaction.requestedSchema))
    const content = createMemo(() => {
      const current = fields()
      if (!current) return undefined
      return codexFormContent(current, store.forms[interaction.id] ?? {})
    })
    return (
      <div data-interaction-id={interaction.id}>
        <DockPrompt
          kind="question"
          header={
            <div data-slot="question-header-title">{interaction.title || language.t("codex.interaction.title")}</div>
          }
          footer={
            <>
              <div />
              <div data-slot="question-footer-actions">
                {ChoiceButtons(interaction, { content: content(), disableAllow: !content() })}
              </div>
            </>
          }
        >
          <div class="flex max-h-72 flex-col gap-3 overflow-y-auto px-2 pb-4">
            <Show when={interaction.description}>
              <div class="whitespace-pre-wrap text-12-regular text-text-weak">{interaction.description}</div>
            </Show>
            <Show
              when={fields() !== undefined}
              fallback={<div class="text-12-regular text-text-critical">{language.t("codex.form.invalid")}</div>}
            >
              <For each={fields() ?? []}>
                {(field) => (
                  <div class="flex flex-col gap-1.5">
                    <Show
                      when={field.type === "boolean"}
                      fallback={
                        <Show
                          when={field.options?.length}
                          fallback={
                            <TextField
                              type={field.type === "number" || field.type === "integer" ? "number" : "text"}
                              label={field.title}
                              description={field.description}
                              required={field.required}
                              min={field.minimum}
                              max={field.maximum}
                              value={String(formValue(interaction.id, field))}
                              disabled={store.busy[`interaction:${interaction.id}`]}
                              onChange={(value) => setFormValue(interaction.id, field.name, value)}
                            />
                          }
                        >
                          <fieldset class="flex flex-col gap-1.5">
                            <legend class="text-12-medium text-text-base">{field.title}</legend>
                            <Show when={field.description}>
                              <div class="text-12-regular text-text-weak">{field.description}</div>
                            </Show>
                            <For each={field.options}>
                              {(option) => {
                                const selected = () => formValue(interaction.id, field)
                                const checked = () => {
                                  const current = selected()
                                  return field.type === "array"
                                    ? Array.isArray(current) && current.includes(option.value)
                                    : current === option.value
                                }
                                return (
                                  <Checkbox
                                    checked={checked()}
                                    disabled={store.busy[`interaction:${interaction.id}`]}
                                    onChange={(next) => {
                                      if (field.type !== "array") {
                                        setFormValue(interaction.id, field.name, next ? option.value : "")
                                        return
                                      }
                                      const value = selected()
                                      const current = Array.isArray(value) ? value : []
                                      setFormValue(
                                        interaction.id,
                                        field.name,
                                        next
                                          ? [...current, option.value]
                                          : current.filter((item) => item !== option.value),
                                      )
                                    }}
                                  >
                                    {option.label}
                                  </Checkbox>
                                )
                              }}
                            </For>
                          </fieldset>
                        </Show>
                      }
                    >
                      <Checkbox
                        checked={formValue(interaction.id, field) === true}
                        disabled={store.busy[`interaction:${interaction.id}`]}
                        onChange={(value) => setFormValue(interaction.id, field.name, value)}
                        description={field.description}
                      >
                        {field.title}
                      </Checkbox>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
            <Show when={store.errors[`interaction:${interaction.id}`]}>
              <div class="text-12-regular text-text-critical">{store.errors[`interaction:${interaction.id}`]}</div>
            </Show>
          </div>
        </DockPrompt>
      </div>
    )
  }

  function InteractionCard(interaction: Interaction) {
    if (interaction.kind === "form") return FormInteraction(interaction)
    const question = interaction.kind === "question"
    return (
      <div data-interaction-id={interaction.id}>
        <DockPrompt
          kind={question ? "question" : "permission"}
          header={
            question ? (
              <div data-slot="question-header-title">
                {interaction.title || interaction.questions?.[0]?.header || language.t("codex.interaction.title")}
              </div>
            ) : (
              <div data-slot="permission-row" data-variant="header">
                <span data-slot="permission-icon">
                  <Icon name="warning" size="normal" />
                </span>
                <div data-slot="permission-header-title">
                  {interaction.title || language.t("codex.interaction.title")}
                </div>
              </div>
            )
          }
          footer={
            <>
              <div />
              <div data-slot={question ? "question-footer-actions" : "permission-footer-actions"}>
                <Show
                  when={question}
                  fallback={<Show when={interaction.kind !== "unsupported"}>{ChoiceButtons(interaction)}</Show>}
                >
                  <Button
                    data-action="reply-questions"
                    size="normal"
                    variant="primary"
                    disabled={!questionsReady(interaction) || store.busy[`interaction:${interaction.id}`]}
                    onClick={() => interactionReply(interaction, { answers: questionAnswers(interaction) })}
                  >
                    {language.t("codex.interaction.reply")}
                  </Button>
                </Show>
              </div>
            </>
          }
        >
          <div class="flex max-h-72 flex-col gap-3 overflow-y-auto px-2 pb-4">
            <Show when={interaction.description}>
              <div class="whitespace-pre-wrap text-12-regular text-text-weak">{interaction.description}</div>
            </Show>
            <Show
              when={
                ["command", "file", "permissions", "unsupported"].includes(interaction.kind) &&
                interaction.details !== undefined
              }
            >
              <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-11-regular text-text-weak">
                {JSON.stringify(interaction.details, undefined, 2)}
              </pre>
            </Show>
            <Show when={interaction.kind === "url" && interaction.url}>
              <Button
                data-action="open-url"
                size="small"
                onClick={() => {
                  if (!webURL(interaction.url)) return
                  platform.openExternal(interaction.url)
                }}
              >
                {language.t("codex.url.open")}
              </Button>
            </Show>
            <Show when={question}>{QuestionInteraction(interaction)}</Show>
            <Show when={store.errors[`interaction:${interaction.id}`]}>
              <div class="text-12-regular text-text-critical">{store.errors[`interaction:${interaction.id}`]}</div>
            </Show>
          </div>
        </DockPrompt>
      </div>
    )
  }

  return (
    <Show when={actionable()}>
      <div data-component="codex-session-docks" class="flex flex-col gap-2">
        <Show when={!!recoveryError()}>
          <DockTray data-component="codex-recovery-dock" attach="top">
            <div class="flex min-h-12 items-center gap-2 px-3 py-2">
              <span class="text-12-regular text-text-critical">{recoveryError()}</span>
              <Button data-action="retry" size="small" disabled={store.busy.recovery} onClick={retry}>
                {language.t("session.inspector.retry")}
              </Button>
              <Show when={descriptor()?.canTakeover && props.sessionID}>
                <Button
                  data-action="takeover"
                  size="small"
                  disabled={store.busy.recovery}
                  onClick={() =>
                    void run("recovery", props.sessionID, () => external().actions.takeover(props.sessionID!))
                  }
                >
                  {language.t("codex.task.takeover")}
                </Button>
              </Show>
            </div>
          </DockTray>
        </Show>

        <For each={interactions()}>{InteractionCard}</For>

        <Show when={deliveries().length > 0}>
          <DockTray data-component="codex-queue-dock" attach="top">
            <div class="flex max-h-42 flex-col gap-1.5 overflow-y-auto px-3 py-2">
              <For each={deliveries()}>
                {(delivery) => (
                  <div data-delivery-id={delivery.requestID} class="flex min-w-0 flex-wrap items-center gap-2 py-1">
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-13-regular text-text-base">
                        {delivery.input.prompt.text.trim().split(/\r?\n/).find(Boolean) ||
                          language.t("common.attachment")}
                      </div>
                      <div class="flex flex-wrap gap-1.5 text-11-regular text-text-weak">
                        <span>
                          {delivery.delivery === "queue"
                            ? language.t("codex.delivery.queue")
                            : language.t("codex.delivery.steer")}
                          {` · ${deliveryState(delivery)}`}
                        </span>
                        <Show when={delivery.state === "unknown"}>
                          <span>{language.t("codex.delivery.unknownHint")}</span>
                        </Show>
                        <Show when={deliveryHint(delivery)}>{(hint) => <span>{hint()}</span>}</Show>
                        <Show when={delivery.error}>
                          {(error) => <span class="text-text-critical">{error()}</span>}
                        </Show>
                      </div>
                    </div>
                    <Show
                      when={
                        delivery.state === "unknown" ||
                        delivery.state === "sending" ||
                        needsCodexDeliveryConfirmation(delivery)
                      }
                    >
                      <Button
                        data-action="check-delivery"
                        size="small"
                        disabled={store.busy[`delivery:${delivery.requestID}`]}
                        onClick={() => checkDelivery(delivery)}
                      >
                        {language.t("codex.delivery.check")}
                      </Button>
                    </Show>
                    <Show
                      when={
                        needsCodexDeliveryConfirmation(delivery) &&
                        descriptor()?.runtimeStatus === "idle" &&
                        props.onCopyDeliveryText &&
                        props.canCopyDeliveryText?.() !== false
                      }
                    >
                      <Button
                        data-action="copy-delivery-text"
                        size="small"
                        onClick={() => {
                          if (
                            descriptor()?.runtimeStatus !== "idle" ||
                            !needsCodexDeliveryConfirmation(delivery) ||
                            props.canCopyDeliveryText?.() === false
                          )
                            return
                          props.onCopyDeliveryText?.(delivery)
                        }}
                      >
                        {language.t("codex.delivery.copyText")}
                      </Button>
                    </Show>
                    <Show when={["pending", "paused", "returned"].includes(delivery.state)}>
                      <Button
                        data-action="withdraw-delivery"
                        size="small"
                        disabled={store.busy[`delivery:${delivery.requestID}`]}
                        onClick={() => queue("withdraw", delivery)}
                      >
                        {language.t("codex.queue.withdraw")}
                      </Button>
                      <Show
                        when={
                          delivery.state === "paused" ||
                          delivery.state === "returned" ||
                          (queuePaused() && pendingQueue()?.requestID === delivery.requestID)
                        }
                      >
                        <Button
                          data-action="resume-queue"
                          size="small"
                          variant="primary"
                          disabled={
                            store.busy[`delivery:${delivery.requestID}`] ||
                            (delivery.delivery === "queue" && descriptor()?.runtimeStatus !== "idle")
                          }
                          onClick={() => queue("resume", delivery)}
                        >
                          {language.t("codex.queue.resume")}
                        </Button>
                      </Show>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </DockTray>
        </Show>

        <Show when={planTodos().length > 0}>
          <div data-component="codex-plan-dock">
            <SessionTodoDock
              todos={planTodos()}
              collapsed={store.planCollapsed}
              onToggle={() => setStore("planCollapsed", (value) => !value)}
              collapseLabel={language.t("session.todo.collapse")}
              expandLabel={language.t("session.todo.expand")}
              dockProgress={1}
            />
          </div>
        </Show>
      </div>
    </Show>
  )
}

function formOptions(schema: Record<string, unknown>): FormOption[] | undefined {
  if (Array.isArray(schema.oneOf))
    return schema.oneOf.flatMap((item) =>
      record(item) && typeof item.const === "string" && typeof item.title === "string"
        ? [{ label: item.title, value: item.const }]
        : [],
    )
  if (Array.isArray(schema.enum))
    return schema.enum.flatMap((value, index) =>
      typeof value === "string"
        ? [
            {
              label:
                Array.isArray(schema.enumNames) && typeof schema.enumNames[index] === "string"
                  ? schema.enumNames[index]
                  : value,
              value,
            },
          ]
        : [],
    )
  if (!record(schema.items)) return undefined
  if (Array.isArray(schema.items.anyOf))
    return schema.items.anyOf.flatMap((item) =>
      record(item) && typeof item.const === "string" && typeof item.title === "string"
        ? [{ label: item.title, value: item.const }]
        : [],
    )
  if (!Array.isArray(schema.items.enum)) return undefined
  return schema.items.enum.flatMap((value) => (typeof value === "string" ? [{ label: value, value }] : []))
}

function formDefault(type: CodexFormField["type"], value: unknown): CodexFormField["defaultValue"] {
  if (type === "boolean") return typeof value === "boolean" ? value : undefined
  if (type === "array")
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined
  if (type === "number" || type === "integer") return typeof value === "number" ? String(value) : undefined
  return typeof value === "string" ? value : undefined
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function integer(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

function formType(value: unknown): value is CodexFormField["type"] {
  return ["string", "number", "integer", "boolean", "array"].includes(String(value))
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function webURL(value: unknown): value is string {
  if (typeof value !== "string" || !URL.canParse(value)) return false
  return ["http:", "https:"].includes(new URL(value).protocol)
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (record(error) && typeof error.message === "string") return error.message
  return String(error)
}
