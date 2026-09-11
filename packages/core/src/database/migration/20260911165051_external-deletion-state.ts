import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260911165051_external-deletion-state",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_external_binding\` ADD \`deletion_state\` text;`)
      yield* tx.run(`ALTER TABLE \`session_external_binding\` ADD \`deletion_generation\` text;`)
      yield* tx.run(`ALTER TABLE \`session_external_binding\` ADD \`deletion_error\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
