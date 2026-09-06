import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260906175458_external-execution-pending",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `ALTER TABLE \`session_external_binding\` ADD \`execution_pending\` integer DEFAULT false NOT NULL;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
