import { For, Show } from "solid-js"
import { CheckboxV2 } from "@opencode-ai/ui/v2/checkbox-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"

export function PromptWorkspaceSelector(props: {
  isolated: boolean
  branch?: string
  baseBranch?: string
  branches?: string[]
  worktreeDisabled?: boolean
  optionsLoading?: boolean
  optionsFailed?: boolean
  onRetry?: () => void
  onIsolationChange: (value: boolean) => void
  onBaseBranchChange?: (value: string) => void
  onDone: () => void
}) {
  const language = useLanguage()
  const branchLabel = () => {
    if (props.optionsLoading) return language.t("common.loading")
    return props.baseBranch ?? props.branch ?? language.t("session.new.worktree.baseBranch")
  }

  return (
    <>
      <span class="hidden select-none opacity-50 sm:inline mx-1">/</span>
      <MenuV2 placement="bottom" gutter={4} onOpenChange={(open) => !open && props.onDone()}>
        <MenuV2.Trigger
          data-action="prompt-base-branch"
          class="flex h-7 min-w-0 max-w-[220px] items-center gap-1.5 rounded-sm px-2 hover:bg-v2-overlay-simple-overlay-hover focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none data-[expanded]:bg-v2-overlay-simple-overlay-pressed data-[expanded]:text-v2-text-text-muted"
        >
          <IconV2 name="branch" class="shrink-0 text-v2-icon-icon-muted" />
          <span class="min-w-0 truncate">{branchLabel()}</span>
          <Icon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content class="max-h-80 w-[220px] overflow-y-auto">
            <MenuV2.Group>
              <MenuV2.GroupLabel>{language.t("session.new.worktree.baseBranch")}</MenuV2.GroupLabel>
              <Show when={props.optionsLoading}>
                <div class="px-2 py-1 text-v2-text-text-faint" role="status">
                  {language.t("common.loading")}
                </div>
              </Show>
              <Show when={props.optionsFailed}>
                <div class="px-2 py-1 text-v2-text-text-danger" role="alert">
                  {language.t("session.new.worktree.optionsFailed")}
                </div>
                <MenuV2.Item onSelect={() => props.onRetry?.()}>
                  <span class="min-w-0 flex-1 truncate">{language.t("workspace.retry")}</span>
                </MenuV2.Item>
              </Show>
              <For each={props.branches ?? []}>
                {(branch) => (
                  <MenuV2.Item closeOnSelect onSelect={() => props.onBaseBranchChange?.(branch)}>
                    <IconV2 name="branch" />
                    <span class="min-w-0 flex-1 truncate">{branch}</span>
                    <Show when={props.baseBranch === branch}>
                      <Icon name="check" size="small" class="shrink-0" />
                    </Show>
                  </MenuV2.Item>
                )}
              </For>
            </MenuV2.Group>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
      <span class="hidden select-none opacity-50 sm:inline mx-1">/</span>
      <CheckboxV2
        data-action="prompt-worktree"
        class="h-7 justify-center rounded-sm px-2 text-v2-text-text-faint hover:bg-v2-overlay-simple-overlay-hover"
        checked={props.isolated}
        disabled={props.worktreeDisabled}
        label={language.t("session.new.worktree.label")}
        onChange={props.onIsolationChange}
      />
    </>
  )
}

export function PromptGitStatus(props: { branch?: string; noGit?: boolean }) {
  const language = useLanguage()
  const label = () => {
    if (props.noGit) return language.t("session.new.git.none")
    return props.branch
  }

  return (
    <Show when={label()}>
      {(value) => (
        <TooltipV2
          placement="top"
          value={value()}
          class="min-w-0 max-w-[220px]"
          contentClass="max-w-[calc(100vw-32px)] break-all"
        >
          <div
            data-action="prompt-current-branch"
            class="flex h-7 min-w-0 max-w-[220px] items-center gap-1.5 px-2 text-[13px] font-[440] leading-5 tracking-[-0.04px]"
          >
            <Icon name="branch" size="small" class="shrink-0 text-v2-icon-icon-muted" />
            <span class="min-w-0 truncate">{value()}</span>
          </div>
        </TooltipV2>
      )}
    </Show>
  )
}
