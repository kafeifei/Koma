import type { JsonValue, LabEnginesOutput, LabSnapshotOutput } from "@opencode-ai/lab-client"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { TextField } from "@opencode-ai/ui/text-field"
import { useNavigate } from "@solidjs/router"
import { createEffect, createMemo, For, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { sessionHref } from "@/utils/session-route"
import { showToast } from "@/utils/toast"

type Interaction = LabSnapshotOutput["interactions"][number]
type Delivery = LabSnapshotOutput["deliveries"][number]

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

export function reconcileCodexLoginID(
  local: string | undefined,
  account: LabEnginesOutput[number]["account"] | undefined,
) {
  if (!account) return local
  if (account.loginState === "pending") return account.loginID ?? local
  if (account.authenticated || account.loginState === "complete" || account.loginState === "failed" || account.error) {
    return undefined
  }
  return local
}

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

export function CodexSessionControls(props: { sessionID?: string; engine?: "opencode" | "codex" }) {
  const serverSync = useServerSync()
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const language = useLanguage()
  const navigate = useNavigate()
  const [store, setStore] = createStore({
    busy: {} as Record<string, boolean | undefined>,
    errors: {} as Record<string, string | undefined>,
    loginID: undefined as string | undefined,
    answers: {} as Record<string, Record<string, string[] | undefined> | undefined>,
    other: {} as Record<string, Record<string, string | undefined> | undefined>,
    forms: {} as Record<string, Record<string, FormValue | undefined> | undefined>,
  })

  const external = createMemo(() => serverSync().external)
  const descriptor = createMemo(() => (props.sessionID ? external().data.descriptors[props.sessionID] : undefined))
  const snapshot = createMemo(() => (props.sessionID ? external().data.snapshots[props.sessionID] : undefined))
  const engine = createMemo(() => external().data.engines?.find((item) => item.id === "codex"))
  const account = createMemo(() => engine()?.account)
  const visible = createMemo(() => props.engine === "codex" || descriptor()?.engine === "codex")
  const loginID = createMemo(() => store.loginID ?? account()?.loginID)

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

  onMount(() => {
    void external()
      .refreshEngines()
      .catch((error) => fail("account", error))
  })

  createEffect(() => {
    const sessionID = props.sessionID
    if (!sessionID) return
    void external()
      .load(sessionID)
      .catch((error) => fail("snapshot", error))
  })

  createEffect(() => {
    const next = reconcileCodexLoginID(store.loginID, account())
    if (next !== store.loginID) setStore("loginID", next)
  })

  const signIn = () =>
    void run("account", undefined, async () => {
      const login = await external().actions.login()
      setStore("loginID", login.loginID)
      if (!webURL(login.url)) throw new Error(login.url)
      platform.openExternal(login.url)
    })

  const cancelSignIn = () => {
    const current = loginID()
    if (!current) return
    void run("account", undefined, async () => {
      await external().actions.cancelLogin(current)
      setStore("loginID", undefined)
    })
  }

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

  const pause = () => {
    const sessionID = props.sessionID
    if (!sessionID) return
    void run("pause", sessionID, () => external().actions.interrupt(sessionID))
  }

  const checkDelivery = (delivery: Delivery) =>
    void run(`delivery:${delivery.requestID}`, delivery.sessionID, () =>
      external().actions.delivery({ sessionID: delivery.sessionID, requestID: delivery.requestID }),
    )

  const deliveries = createMemo(() => {
    const values = snapshot()?.deliveries ?? []
    const recent = values.toSorted((a, b) => b.createdAt - a.createdAt).slice(0, 5)
    return [
      ...new Map(
        [...values.filter((item) => item.state === "pending"), ...recent].map((item) => [item.requestID, item]),
      ).values(),
    ]
  })
  const pendingQueue = createMemo(() =>
    snapshot()?.deliveries.find((item) => item.delivery === "queue" && item.state === "pending"),
  )
  const interactions = createMemo(() => snapshot()?.interactions.filter((item) => item.state === "pending") ?? [])
  const plan = createMemo(() => {
    const current = snapshot()?.plan
    return current?.status === "available" ? current.value : undefined
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

  const statusLabel = () => {
    const status = descriptor()?.runtimeStatus
    if (status === "resolving") return language.t("codex.runtime.resolving")
    if (status === "creating") return language.t("codex.runtime.creating")
    if (status === "idle") return language.t("codex.runtime.idle")
    if (status === "active") return language.t("codex.runtime.active")
    if (status === "waitingApproval") return language.t("codex.runtime.waitingApproval")
    if (status === "waitingInput") return language.t("codex.runtime.waitingInput")
    if (status === "interrupting") return language.t("codex.runtime.interrupting")
    if (status === "disconnected") return language.t("codex.runtime.disconnected")
    if (status === "systemError") return language.t("codex.runtime.systemError")
    if (status === "bindingUnavailable") return language.t("codex.runtime.bindingUnavailable")
    return undefined
  }

  const deliveryState = (delivery: Delivery) => {
    if (delivery.state === "pending") return language.t("codex.delivery.pending")
    if (delivery.state === "sending") return language.t("codex.delivery.sending")
    if (delivery.state === "accepted") return language.t("codex.delivery.accepted")
    if (delivery.state === "unknown") return language.t("codex.delivery.unknown")
    if (delivery.state === "rejected") return language.t("codex.delivery.rejected")
    return language.t("codex.delivery.withdrawn")
  }

  const planState = (status: "pending" | "inProgress" | "completed") => {
    if (status === "pending") return language.t("codex.plan.pending")
    if (status === "inProgress") return language.t("codex.plan.inProgress")
    return language.t("codex.plan.completed")
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
        <Button
          data-action="reply-questions"
          size="small"
          variant="primary"
          disabled={!questionsReady(interaction) || store.busy[`interaction:${interaction.id}`]}
          onClick={() => interactionReply(interaction, { answers: questionAnswers(interaction) })}
        >
          {language.t("codex.interaction.reply")}
        </Button>
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
      <div class="flex flex-col gap-3">
        <Show
          when={fields()}
          fallback={<div class="text-12-regular text-text-critical">{language.t("codex.form.invalid")}</div>}
        >
          {(items) => (
            <For each={items()}>
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
          )}
        </Show>
        <Show when={!content()}>
          <div class="text-12-regular text-text-critical">{language.t("codex.form.invalid")}</div>
        </Show>
        {ChoiceButtons(interaction, { content: content(), disableAllow: !content() })}
      </div>
    )
  }

  function InteractionCard(interaction: Interaction) {
    return (
      <section
        data-interaction-id={interaction.id}
        class="flex flex-col gap-2 rounded-md border border-border-weak-base bg-surface-base p-3"
      >
        <div class="text-12-medium text-text-base">{interaction.title || language.t("codex.interaction.title")}</div>
        <Show when={interaction.description}>
          <div class="whitespace-pre-wrap text-12-regular text-text-weak">{interaction.description}</div>
        </Show>
        <Show
          when={
            ["command", "file", "permissions", "unsupported"].includes(interaction.kind) &&
            interaction.details !== undefined
          }
        >
          <pre class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-background-base p-2 font-mono text-11-regular text-text-weak">
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
        <Show when={interaction.kind === "question"}>{QuestionInteraction(interaction)}</Show>
        <Show when={interaction.kind === "form"}>{FormInteraction(interaction)}</Show>
        <Show when={!["question", "form", "unsupported"].includes(interaction.kind)}>{ChoiceButtons(interaction)}</Show>
        <Show when={store.errors[`interaction:${interaction.id}`]}>
          <div class="text-12-regular text-text-critical">{store.errors[`interaction:${interaction.id}`]}</div>
        </Show>
      </section>
    )
  }

  return (
    <Show when={visible()}>
      <aside
        data-component="codex-session-controls"
        class="flex flex-col gap-3 rounded-lg border border-border-weak-base bg-background-base p-3"
      >
        <div class="flex items-center justify-between gap-3">
          <div class="text-12-medium text-text-base">{language.t("codex.controls.title")}</div>
          <Show when={statusLabel()}>{(label) => <div class="text-11-regular text-text-weak">{label()}</div>}</Show>
        </div>

        <Show
          when={
            engine()?.error || account()?.error || descriptor()?.error || external().data.errors[props.sessionID ?? ""]
          }
        >
          {(error) => <div class="whitespace-pre-wrap text-12-regular text-text-critical">{error()}</div>}
        </Show>

        <Show when={account()?.authenticated}>
          <div class="text-12-regular text-text-weak">
            {language.t("codex.account.signedIn")}
            {account()?.label ? ` · ${account()!.label}` : ""}
          </div>
        </Show>
        <Show when={!account()?.authenticated && account()?.requiresAuth !== false}>
          <div class="flex flex-wrap items-center gap-2">
            <Show
              when={loginID()}
              fallback={
                <Button
                  data-action="sign-in"
                  size="small"
                  variant="primary"
                  disabled={store.busy.account || engine()?.available === false}
                  onClick={signIn}
                >
                  {engine()?.available === false
                    ? language.t("codex.account.unavailable")
                    : language.t("codex.account.signIn")}
                </Button>
              }
            >
              <span class="text-12-regular text-text-weak">{language.t("codex.account.pending")}</span>
              <Button data-action="cancel-sign-in" size="small" disabled={store.busy.account} onClick={cancelSignIn}>
                {language.t("codex.account.cancelSignIn")}
              </Button>
            </Show>
          </div>
        </Show>

        <Show when={descriptor()?.pendingSettings}>
          {(settings) => (
            <section class="flex flex-col gap-1 rounded-md bg-surface-base p-2">
              <div class="text-11-medium text-text-base">{language.t("codex.pendingSettings.title")}</div>
              <Show when={settings().model}>
                <div class="text-11-regular text-text-weak">
                  {language.t("codex.settings.model")}: {settings().model}
                </div>
              </Show>
              <Show when={settings().effort}>
                <div class="text-11-regular text-text-weak">
                  {language.t("codex.settings.effort")}: {settings().effort}
                </div>
              </Show>
              <Show when={settings().permission}>
                <div class="text-11-regular text-text-weak">
                  {language.t("codex.settings.permission")}: {settings().permission}
                </div>
              </Show>
            </section>
          )}
        </Show>

        <Show when={snapshot()?.plan?.status === "loading"}>
          <section data-component="codex-plan" class="flex flex-col gap-1.5 rounded-md bg-surface-base p-2">
            <div class="text-11-medium text-text-base">{language.t("codex.plan.title")}</div>
            <div class="text-11-regular text-text-weak">{language.t("codex.plan.loading")}</div>
          </section>
        </Show>
        <Show when={plan()}>
          {(plan) => (
            <section data-component="codex-plan" class="flex flex-col gap-2 rounded-md bg-surface-base p-2">
              <div class="text-11-medium text-text-base">{language.t("codex.plan.title")}</div>
              <Show when={plan().explanation}>
                <div class="whitespace-pre-wrap text-12-regular text-text-weak">{plan().explanation}</div>
              </Show>
              <ol class="flex flex-col gap-1.5">
                <For each={plan().steps}>
                  {(step) => (
                    <li
                      data-plan-step-status={step.status}
                      class="flex items-start justify-between gap-3 text-12-regular"
                    >
                      <span class="min-w-0 whitespace-pre-wrap text-text-base">{step.step}</span>
                      <span class="shrink-0 text-11-regular text-text-weak">{planState(step.status)}</span>
                    </li>
                  )}
                </For>
              </ol>
            </section>
          )}
        </Show>

        <Show when={descriptor()}>
          {(current) => (
            <section class="flex flex-col gap-2">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-11-medium text-text-base">{language.t("codex.queue.title")}</span>
                <Show when={current().queuePaused}>
                  <span class="text-11-regular text-text-weak">{language.t("codex.queue.paused")}</span>
                  <Button
                    data-action="resume-queue"
                    size="small"
                    disabled={!pendingQueue() || store.busy[`delivery:${pendingQueue()?.requestID}`]}
                    onClick={() => {
                      const delivery = pendingQueue()
                      if (delivery) queue("resume", delivery)
                    }}
                  >
                    {language.t("codex.queue.resume")}
                  </Button>
                </Show>
                <Show
                  when={
                    !current().queuePaused &&
                    ["active", "waitingApproval", "waitingInput"].includes(current().runtimeStatus)
                  }
                >
                  <Button data-action="pause-queue" size="small" disabled={store.busy.pause} onClick={pause}>
                    {language.t("codex.queue.pause")}
                  </Button>
                </Show>
              </div>
              <For each={deliveries()}>
                {(delivery) => (
                  <div
                    data-delivery-id={delivery.requestID}
                    class="flex flex-wrap items-center gap-2 rounded-md bg-surface-base px-2 py-1.5 text-11-regular"
                  >
                    <span class="text-text-base">
                      {delivery.delivery === "queue"
                        ? language.t("codex.delivery.queue")
                        : language.t("codex.delivery.steer")}
                    </span>
                    <span class="text-text-weak">{deliveryState(delivery)}</span>
                    <Show when={delivery.error}>
                      <span class="text-text-critical">{delivery.error}</span>
                    </Show>
                    <Show when={delivery.state === "unknown"}>
                      <span class="text-text-weak">{language.t("codex.delivery.unknownHint")}</span>
                    </Show>
                    <Show when={delivery.state === "unknown" || delivery.state === "sending"}>
                      <Button
                        data-action="check-delivery"
                        size="small"
                        disabled={store.busy[`delivery:${delivery.requestID}`]}
                        onClick={() => checkDelivery(delivery)}
                      >
                        {language.t("codex.delivery.check")}
                      </Button>
                    </Show>
                    <Show when={delivery.delivery === "queue" && delivery.state === "pending"}>
                      <Button
                        data-action="withdraw-delivery"
                        size="small"
                        disabled={store.busy[`delivery:${delivery.requestID}`]}
                        onClick={() => queue("withdraw", delivery)}
                      >
                        {language.t("codex.queue.withdraw")}
                      </Button>
                    </Show>
                  </div>
                )}
              </For>
            </section>
          )}
        </Show>

        <For each={interactions()}>{InteractionCard}</For>

        <Show when={(snapshot()?.children.length ?? 0) > 0}>
          <section class="flex flex-col gap-2">
            <div class="text-11-medium text-text-base">{language.t("session.inspector.subagents")}</div>
            <For each={snapshot()?.children ?? []}>
              {(child) => (
                <div
                  data-child-session-id={child.sessionID}
                  class="flex items-center justify-between gap-2 rounded-md bg-surface-base px-2 py-1.5"
                >
                  <code class="min-w-0 truncate text-11-regular text-text-weak">{child.nativeThreadID}</code>
                  <Button
                    size="small"
                    onClick={() => navigate(sessionHref(ServerConnection.key(serverSDK().server), child.sessionID))}
                  >
                    {language.t("common.open")}
                  </Button>
                </div>
              )}
            </For>
          </section>
        </Show>

        <Show when={store.errors.snapshot || store.errors.account || store.errors.pause}>
          <div class="text-12-regular text-text-critical">
            {store.errors.snapshot ?? store.errors.account ?? store.errors.pause}
          </div>
        </Show>
      </aside>
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
