import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260906155326_session-external",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_external_binding\` (
          \`session_id\` text PRIMARY KEY,
          \`runtime_scope\` text NOT NULL,
          \`native_thread_id\` text,
          \`state\` text NOT NULL,
          \`generation\` text,
          \`queue_paused\` integer DEFAULT false NOT NULL,
          \`settings\` text DEFAULT '{}' NOT NULL,
          \`projection_version\` integer DEFAULT 1 NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`error\` text,
          CONSTRAINT \`fk_session_external_binding_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_external_delivery\` (
          \`session_id\` text NOT NULL,
          \`request_id\` text NOT NULL,
          \`sequence\` integer NOT NULL,
          \`create_scope\` text,
          \`create_fingerprint\` text,
          \`fingerprint\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`state\` text NOT NULL,
          \`generation\` text,
          \`native_turn_id\` text,
          \`native_item_id\` text,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_external_delivery_pk\` PRIMARY KEY(\`session_id\`, \`request_id\`),
          CONSTRAINT \`fk_session_external_delivery_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`engine\` text DEFAULT 'opencode' NOT NULL;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_external_binding_native_idx\` ON \`session_external_binding\` (\`runtime_scope\`,\`native_thread_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_external_binding_scope_idx\` ON \`session_external_binding\` (\`runtime_scope\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_external_delivery_create_idx\` ON \`session_external_delivery\` (\`create_scope\`,\`request_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_external_delivery_sequence_idx\` ON \`session_external_delivery\` (\`session_id\`,\`sequence\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_external_delivery_pending_idx\` ON \`session_external_delivery\` (\`session_id\`,\`state\`,\`sequence\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
