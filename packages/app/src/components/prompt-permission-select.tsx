import { useSearchParams } from "@solidjs/router"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import type { Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePermission } from "@/context/permission"
import { useSDK } from "@/context/sdk"
import type { PermissionMode } from "@/context/tabs"
import { formatServerError } from "@/utils/server-errors"
import { showToast } from "@/utils/toast"
import "./prompt-permission-select.css"

export type PromptPermissionMode = PermissionMode

export type PromptPermissionSelectController = {
  ready(): boolean
  current(): PromptPermissionMode | undefined
  select(mode: PromptPermissionMode): boolean | void | Promise<boolean | void>
}

export function createPromptPermissionController(sessionID: Accessor<string | undefined>) {
  const permission = usePermission()
  const sdk = useSDK()
  const language = useLanguage()
  const [search] = useSearchParams<{ draftId?: string }>()
  const [state, setState] = createStore({ pending: false })

  const ready = () => {
    const target = sdk()
    if (state.pending || !permission.ready(target.scope)) return false
    const id = sessionID()
    if (id) return permission.sessionReady(target.scope, id)
    return !search.draftId || permission.newSessionReady()
  }

  const current = (): PromptPermissionMode => {
    const target = sdk()
    const id = sessionID()
    if (id) return permission.sessionMode(target.scope, id)
    return permission.newSessionMode(target.scope, target.directory, search.draftId)
  }

  const select = async (mode: PromptPermissionMode) => {
    if (!ready()) return false
    if (mode === current()) return true
    const target = sdk()
    const id = sessionID()
    if (!id) {
      permission.setNewSessionMode(target.scope, target.directory, mode, search.draftId)
      return true
    }

    setState("pending", true)
    try {
      await permission.setSessionMode(target.scope, id, target.directory, mode)
      return true
    } catch (error) {
      showToast({
        title: language.t("prompt.permission.updateFailed.title"),
        description: formatServerError(error, language.t, language.t("prompt.permission.updateFailed.description")),
      })
      return false
    } finally {
      setState("pending", false)
    }
  }

  return {
    ready,
    current,
    select,
    toggle: () => select(current() === "auto" ? "default" : "auto"),
  }
}

export type PromptPermissionController = ReturnType<typeof createPromptPermissionController>

export function PromptPermissionSelect(props: { controller: PromptPermissionSelectController; onClose?: () => void }) {
  const language = useLanguage()
  let open = false
  const label = () => {
    if (props.controller.current() === "auto") return language.t("prompt.permission.auto.label")
    if (props.controller.current() === "full") return language.t("prompt.permission.full.label")
    if (props.controller.current() === "default") return language.t("prompt.permission.default.label")
    return language.t("prompt.permission.ariaLabel")
  }

  return (
    <MenuV2
      modal={false}
      placement="top-end"
      gutter={6}
      onOpenChange={(next) => {
        const previous = open
        open = next
        if (previous && !next) props.onClose?.()
      }}
    >
      <MenuV2.Trigger
        as={ButtonV2}
        data-action="prompt-permission"
        type="button"
        variant="ghost-muted"
        size="normal"
        disabled={!props.controller.ready()}
        class="min-w-0 max-w-36 shrink-0 gap-1 px-2 ![font-weight:440]"
        aria-label={language.t("prompt.permission.ariaLabel")}
      >
        <span class="truncate">{label()}</span>
        <Icon name="chevron-down" size="small" class="shrink-0" />
      </MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content class="w-72" data-slot="prompt-permission-menu">
          <MenuV2.RadioGroup
            value={props.controller.current() ?? ""}
            onChange={(value) => void props.controller.select(value as PromptPermissionMode)}
          >
            <MenuV2.RadioItem value="default" closeOnSelect class="!h-auto !py-2">
              <span class="flex min-w-0 flex-col gap-1 leading-4">
                <span class="text-v2-text-text-base">{language.t("prompt.permission.default.label")}</span>
                <span class="whitespace-normal text-v2-text-text-muted">
                  {language.t("prompt.permission.default.description")}
                </span>
              </span>
            </MenuV2.RadioItem>
            <MenuV2.RadioItem value="auto" closeOnSelect class="!h-auto !py-2">
              <span class="flex min-w-0 flex-col gap-1 leading-4">
                <span class="text-v2-text-text-base">{language.t("prompt.permission.auto.label")}</span>
                <span class="whitespace-normal text-v2-text-text-muted">
                  {language.t("prompt.permission.auto.description")}
                </span>
              </span>
            </MenuV2.RadioItem>
            <MenuV2.RadioItem value="full" closeOnSelect class="!h-auto !py-2">
              <span class="flex min-w-0 flex-col gap-1 leading-4">
                <span class="text-v2-text-text-base">{language.t("prompt.permission.full.label")}</span>
                <span class="whitespace-normal text-v2-text-text-muted">
                  {language.t("prompt.permission.full.description")}
                </span>
              </span>
            </MenuV2.RadioItem>
          </MenuV2.RadioGroup>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}
