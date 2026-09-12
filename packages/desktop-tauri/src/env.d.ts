interface ImportMetaEnv {
  readonly OPENCODE_BUILD: import("@opencode-ai/app/build-info").BuildInfo & { version: string }
}
