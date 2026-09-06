export * as SessionExternal from "./session-external"

import { Schema, Struct } from "effect"
import { Event } from "./event"
import { FileDiff } from "./file-diff"
import { Location } from "./location"
import { Model } from "./model"
import { Prompt } from "./prompt"
import { optional } from "./schema"
import { SessionID } from "./session-id"
import { SessionMessage } from "./session-message"

export const RuntimeStatus = Schema.Literals([
  "resolving",
  "creating",
  "idle",
  "active",
  "waitingApproval",
  "waitingInput",
  "interrupting",
  "disconnected",
  "systemError",
  "bindingUnavailable",
]).annotate({ identifier: "SessionExternal.RuntimeStatus" })
export type RuntimeStatus = typeof RuntimeStatus.Type

export const Capabilities = Schema.Struct({
  prompt: Schema.Boolean,
  steer: Schema.Boolean,
  queue: Schema.Literals(["native", "host", "unavailable"]),
  compact: Schema.Boolean,
  images: Schema.Boolean,
  permissions: Schema.Boolean,
}).annotate({ identifier: "SessionExternal.Capabilities" })
export interface Capabilities extends Schema.Schema.Type<typeof Capabilities> {}

export const Settings = Schema.Struct({
  model: Schema.String.pipe(optional),
  effort: Schema.String.pipe(optional),
  permission: Schema.Literals(["workspace", "readOnly", "full"]).pipe(optional),
}).annotate({ identifier: "SessionExternal.Settings" })
export interface Settings extends Schema.Schema.Type<typeof Settings> {}

export const Input = Schema.Struct({
  prompt: Prompt,
  settings: Settings,
}).annotate({ identifier: "SessionExternal.Input" })
export interface Input extends Schema.Schema.Type<typeof Input> {}

export const Create = Schema.Struct({
  requestID: Schema.String,
  engine: Schema.Literal("codex"),
  location: Location.Ref,
  input: Input,
  delivery: Schema.Literals(["steer", "queue"]),
}).annotate({ identifier: "SessionExternal.Create" })
export interface Create extends Schema.Schema.Type<typeof Create> {}

export const Submit = Schema.Struct({
  requestID: Schema.String,
  input: Input,
  delivery: Schema.Literals(["steer", "queue"]),
}).annotate({ identifier: "SessionExternal.Submit" })
export interface Submit extends Schema.Schema.Type<typeof Submit> {}

export const Delivery = Schema.Struct({
  sessionID: SessionID,
  requestID: Schema.String,
  state: Schema.Literals(["pending", "sending", "accepted", "unknown", "rejected", "withdrawn"]),
  delivery: Schema.Literals(["steer", "queue"]),
  input: Input,
  nativeTurnID: Schema.String.pipe(optional),
  nativeItemID: Schema.String.pipe(optional),
  error: Schema.String.pipe(optional),
  createdAt: Schema.Finite,
}).annotate({ identifier: "SessionExternal.Delivery" })
export interface Delivery extends Schema.Schema.Type<typeof Delivery> {}

export const Descriptor = Schema.Struct({
  sessionID: SessionID,
  engine: Schema.Literals(["opencode", "codex"]),
  epoch: Schema.String,
  revision: Schema.Int,
  runtimeStatus: RuntimeStatus,
  bindingState: Schema.Literals(["pending", "creating", "bound", "unknown", "failed"]).pipe(optional),
  capabilities: Capabilities,
  queuePaused: Schema.Boolean,
  settings: Settings,
  pendingSettings: Settings.pipe(optional),
  error: Schema.String.pipe(optional),
}).annotate({ identifier: "SessionExternal.Descriptor" })
export interface Descriptor extends Schema.Schema.Type<typeof Descriptor> {}

const Time = Schema.Struct({
  created: Schema.Finite.pipe(optional),
  completed: Schema.Finite.pipe(optional),
})

export const Content = Schema.Union([
  SessionMessage.AssistantText,
  Schema.Struct({ ...Struct.omit(SessionMessage.AssistantReasoning.fields, ["time"]), time: Time.pipe(optional) }),
  Schema.Struct({
    ...Struct.omit(SessionMessage.AssistantTool.fields, ["time", "state"]),
    state: Schema.Union([
      SessionMessage.AssistantTool.fields.state,
      Schema.Struct({
        status: Schema.Literal("unknown"),
        input: Schema.String,
        output: Schema.String.pipe(optional),
        nativeStatus: Schema.String.pipe(optional),
      }),
    ]),
    time: Schema.Struct({ ...Time.fields, ran: Schema.Finite.pipe(optional) }),
  }),
])
export type Content = typeof Content.Type

// Reuse the existing read model; native history may omit times, agent and model.
// These omissions must survive the wire instead of becoming fabricated facts.
const Order = { orderKey: Schema.String, time: Time }
export const Message = Schema.Union([
  Schema.Struct({ ...Struct.omit(SessionMessage.User.fields, ["time"]), ...Order }),
  Schema.Struct({
    ...Struct.omit(SessionMessage.Assistant.fields, ["time", "agent", "model", "content"]),
    ...Order,
    content: Schema.Array(Content),
    streaming: Schema.Boolean.pipe(optional),
    agent: Schema.String.pipe(optional),
    model: Model.Ref.pipe(optional),
  }),
  Schema.Struct({ ...Struct.omit(SessionMessage.System.fields, ["time"]), ...Order }),
]).annotate({ identifier: "SessionExternal.Message" })
export type Message = typeof Message.Type

export const Interaction = Schema.Struct({
  id: Schema.String,
  sessionID: SessionID,
  revision: Schema.Int,
  kind: Schema.Literals(["command", "file", "permissions", "question", "form", "url", "unsupported"]),
  turnRef: Schema.String.pipe(optional),
  itemRef: Schema.String.pipe(optional),
  title: Schema.String,
  description: Schema.String.pipe(optional),
  choices: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.Literals(["allow", "allowSession", "deny", "cancel", "custom"]),
      label: Schema.String.pipe(optional),
      scope: Schema.String.pipe(optional),
    }),
  ),
  questions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      header: Schema.String,
      question: Schema.String,
      options: Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String })).pipe(optional),
      multiple: Schema.Boolean.pipe(optional),
      allowOther: Schema.Boolean.pipe(optional),
      secret: Schema.Boolean.pipe(optional),
    }),
  ).pipe(optional),
  requestedSchema: Schema.Json.pipe(optional),
  url: Schema.String.pipe(optional),
  details: Schema.Json.pipe(optional),
  state: Schema.Literals(["pending", "replying", "resolved", "expired"]),
}).annotate({ identifier: "SessionExternal.Interaction" })
export interface Interaction extends Schema.Schema.Type<typeof Interaction> {}

export const Reply = Schema.Struct({
  revision: Schema.Int,
  choiceID: Schema.String.pipe(optional),
  answers: Schema.Record(Schema.String, Schema.Array(Schema.String)).pipe(optional),
  content: Schema.Json.pipe(optional),
}).annotate({ identifier: "SessionExternal.Reply" })
export interface Reply extends Schema.Schema.Type<typeof Reply> {}

const Tokens = Schema.Struct({
  total: Schema.Finite.pipe(optional),
  input: Schema.Finite,
  output: Schema.Finite,
  reasoning: Schema.Finite,
  cache: Schema.Struct({ read: Schema.Finite, write: Schema.Finite }),
})

export const availability = <S extends Schema.Top>(value: S) =>
  Schema.Union([
    Schema.Struct({ status: Schema.Literal("available"), value }),
    Schema.Struct({ status: Schema.Literals(["unavailable", "loading"]) }),
  ])

export const Plan = Schema.Struct({
  turnID: Schema.String,
  explanation: Schema.String.pipe(optional),
  steps: Schema.Array(
    Schema.Struct({
      step: Schema.String,
      status: Schema.Literals(["pending", "inProgress", "completed"]),
    }),
  ),
})
export interface Plan extends Schema.Schema.Type<typeof Plan> {}

export const Snapshot = Schema.Struct({
  descriptor: Descriptor,
  messages: Schema.Array(Message),
  messageOrder: Schema.Array(Schema.String),
  partOrder: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  interactions: Schema.Array(Interaction),
  deliveries: Schema.Array(Delivery),
  usage: availability(Tokens),
  contextWindow: availability(Schema.Finite),
  contextTokens: availability(Schema.Finite).pipe(optional),
  cost: availability(Schema.Finite),
  turnDiffs: Schema.Record(Schema.String, availability(Schema.Array(FileDiff.Info))),
  sessionDiff: availability(Schema.Array(FileDiff.Info)),
  plan: availability(Plan).pipe(optional),
  children: Schema.Array(Schema.Struct({ sessionID: SessionID, nativeThreadID: Schema.String })),
}).annotate({ identifier: "SessionExternal.Snapshot" })
export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}

export const Account = Schema.Struct({
  authenticated: Schema.Boolean,
  requiresAuth: Schema.Boolean,
  label: Schema.String.pipe(optional),
  plan: Schema.String.pipe(optional),
  loginID: Schema.String.pipe(optional),
  loginState: Schema.Literals(["pending", "complete", "failed"]).pipe(optional),
  error: Schema.String.pipe(optional),
}).annotate({ identifier: "SessionExternal.Account" })
export interface Account extends Schema.Schema.Type<typeof Account> {}

export const Login = Schema.Struct({ loginID: Schema.String, url: Schema.String }).annotate({
  identifier: "SessionExternal.Login",
})
export interface Login extends Schema.Schema.Type<typeof Login> {}

export const Engine = Schema.Struct({
  id: Schema.Literal("codex"),
  available: Schema.Boolean,
  version: Schema.String.pipe(optional),
  error: Schema.String.pipe(optional),
  account: Account,
  capabilities: Capabilities,
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      default: Schema.Boolean,
      efforts: Schema.Array(Schema.String),
      defaultEffort: Schema.String.pipe(optional),
    }),
  ),
}).annotate({ identifier: "SessionExternal.Engine" })
export interface Engine extends Schema.Schema.Type<typeof Engine> {}

// Current, non-durable presentation events; never runner/history events.
export const Changed = Event.define({
  type: "session.external.changed",
  schema: {
    sessionID: SessionID,
    epoch: Schema.String,
    revision: Schema.Int,
    descriptor: Descriptor.pipe(optional),
    messages: Schema.Array(Message).pipe(optional),
    append: Schema.Struct({
      messageID: Schema.String,
      partID: Schema.String,
      type: Schema.Literals(["text", "reasoning"]),
      delta: Schema.String,
    }).pipe(optional),
    refresh: Schema.Boolean.pipe(optional),
    activityAt: Schema.Finite.pipe(optional),
  },
})
export const EngineChanged = Event.define({
  type: "session.external.engine.changed",
  schema: { engine: Schema.Literal("codex") },
})
export const Definitions = Event.inventory(Changed, EngineChanged)
