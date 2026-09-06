import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260906081302_session-permission-mode",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`permission_mode\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
