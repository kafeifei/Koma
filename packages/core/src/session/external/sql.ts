import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import type { Schema } from "effect"
import { SessionTable } from "../sql"
import { SessionSchema } from "../schema"

export const SessionExternalBindingTable = sqliteTable(
  "session_external_binding",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    runtime_scope: text().notNull(),
    native_thread_id: text(),
    state: text().$type<"pending" | "creating" | "bound" | "unknown" | "failed">().notNull(),
    generation: text(),
    queue_paused: integer({ mode: "boolean" }).notNull().default(false),
    execution_pending: integer({ mode: "boolean" }).notNull().default(false),
    settings: text({ mode: "json" }).$type<Schema.Json>().notNull().default({}),
    projection_version: integer().notNull().default(1),
    time_updated: integer().notNull(),
    error: text(),
  },
  (table) => [
    uniqueIndex("session_external_binding_native_idx").on(table.runtime_scope, table.native_thread_id),
    index("session_external_binding_scope_idx").on(table.runtime_scope),
  ],
)

export const SessionExternalDeliveryTable = sqliteTable(
  "session_external_delivery",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    request_id: text().notNull(),
    sequence: integer().notNull(),
    // NULL for ordinary input. A first request is unique before a Session ID exists.
    create_scope: text(),
    create_fingerprint: text(),
    fingerprint: text().notNull(),
    payload: text({ mode: "json" }).$type<Schema.Json>().notNull(),
    delivery: text().$type<"steer" | "queue">().notNull(),
    state: text().$type<"pending" | "sending" | "accepted" | "unknown" | "rejected" | "withdrawn">().notNull(),
    generation: text(),
    native_turn_id: text(),
    native_item_id: text(),
    error: text(),
    time_created: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.request_id] }),
    uniqueIndex("session_external_delivery_create_idx").on(table.create_scope, table.request_id),
    uniqueIndex("session_external_delivery_sequence_idx").on(table.session_id, table.sequence),
    index("session_external_delivery_pending_idx").on(table.session_id, table.state, table.sequence),
  ],
)
