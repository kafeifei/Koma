import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260911172111_external-tombstone",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_external_tombstone\` (
          \`runtime_scope\` text NOT NULL,
          \`native_thread_id\` text NOT NULL,
          \`time_confirmed\` integer NOT NULL,
          CONSTRAINT \`session_external_tombstone_pk\` PRIMARY KEY(\`runtime_scope\`, \`native_thread_id\`)
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
