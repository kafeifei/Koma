import { Show, type JSX } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"
import { SessionPermissionDock } from "@/pages/session/composer/session-permission-dock"
import { SessionQuestionDock } from "@/pages/session/composer/session-question-dock"
import { SessionFollowupDock } from "@/pages/session/composer/session-followup-dock"
import { SessionRevertDock } from "@/pages/session/composer/session-revert-dock"
import { SessionTodoDock } from "@/pages/session/composer/session-todo-dock"
import type { SessionComposerRegionController } from "./session-composer-region-controller"
import { createPromptPermissionController, PromptPermissionSelect } from "@/components/prompt-permission-select"

export function SessionComposerRegion(props: {
  controller: SessionComposerRegionController
  promptInput: JSX.Element
}) {
  const language = useLanguage()
  const controller = props.controller
  const settings = useSettings()
  const rolled = () => {
    const revert = controller.revert()
    return revert?.items.length ? revert : undefined
  }

  return (
    <div
      ref={controller.setDockRef}
      data-component="session-prompt-dock"
      classList={{
        "w-full shrink-0 flex flex-col justify-center items-center pb-3 pointer-events-none": true,
        "bg-v2-background-bg-base": settings.general.newLayoutDesigns(),
        "bg-background-stronger": !settings.general.newLayoutDesigns(),
      }}
    >
      <div
        classList={{
          "w-full px-3 pointer-events-auto": true,
          "md:max-w-200 md:mx-auto 2xl:max-w-[1000px]": controller.centered(),
        }}
      >
        <Show when={controller.state.questionRequest()} keyed>
          {(request) => (
            <div hidden={!!controller.archived()}>
              <SessionQuestionDock request={request} onSubmit={controller.onResponseSubmit} />
            </div>
          )}
        </Show>

        <Show when={controller.state.permissionRequest()} keyed>
          {(request) => (
            <div hidden={!!controller.archived()}>
              <SessionPermissionDock
                request={request}
                responding={controller.state.permissionResponding()}
                permissionControl={
                  <SessionPermissionControl sessionID={controller.sessionID} onClose={controller.restoreFocus} />
                }
                onDecide={(response) => {
                  controller.onResponseSubmit()
                  controller.state.decide(response)
                }}
              />
            </div>
          )}
        </Show>

        <Show when={controller.showComposer()}>
          <Show when={controller.dock()}>
            <div
              hidden={!!controller.archived()}
              classList={{
                "overflow-hidden": true,
                "pointer-events-none": controller.dockProgress() < 0.98,
              }}
              style={{
                "max-height": `${controller.dockHeight() * controller.dockProgress()}px`,
              }}
            >
              <div ref={controller.setDockBodyRef}>
                <SessionTodoDock
                  todos={controller.state.todos()}
                  collapsed={controller.todo.collapsed()}
                  onToggle={controller.todo.onToggle}
                  collapseLabel={language.t("session.todo.collapse")}
                  expandLabel={language.t("session.todo.expand")}
                  dockProgress={controller.dockProgress()}
                />
              </div>
            </div>
          </Show>
          <Show
            when={controller.promptReady()}
            fallback={
              <>
                <Show when={rolled()} keyed>
                  {(revert) => (
                    <div class="pb-2" hidden={!!controller.archived()}>
                      <SessionRevertDock
                        items={revert.items}
                        restoring={revert.restoring}
                        disabled={revert.disabled}
                        onRestore={revert.onRestore}
                      />
                    </div>
                  )}
                </Show>
                <div
                  hidden={!!controller.archived()}
                  class="w-full min-h-32 md:min-h-40 rounded-md border border-border-weak-base bg-background-base/50 px-4 py-3 text-text-weak whitespace-pre-wrap pointer-events-none"
                  style={{ "margin-top": `${-36 * controller.dockProgress()}px` }}
                >
                  {controller.handoffPrompt() || language.t("prompt.loading")}
                </div>
              </>
            }
          >
            <Show when={rolled()} keyed>
              {(revert) => (
                <div
                  hidden={!!controller.archived()}
                  style={{
                    "margin-top": `${-36 * controller.dockProgress()}px`,
                  }}
                >
                  <SessionRevertDock
                    items={revert.items}
                    restoring={revert.restoring}
                    disabled={revert.disabled}
                    onRestore={revert.onRestore}
                  />
                </div>
              )}
            </Show>
            <div
              hidden={!!controller.archived()}
              classList={{
                "relative z-[70]": true,
              }}
              style={{
                "margin-top": `${-controller.lift()}px`,
              }}
            >
              <Show when={controller.followup()?.items.length}>
                <SessionFollowupDock
                  items={controller.followup()!.items}
                  sending={controller.followup()!.sending}
                  onSend={controller.followup()!.onSend}
                  onEdit={controller.followup()!.onEdit}
                />
              </Show>
              <Show
                when={controller.child()}
                fallback={<Show when={!controller.state.blocked()}>{props.promptInput}</Show>}
              >
                <div
                  ref={controller.setPromptRef}
                  class="w-full rounded-[12px] border border-border-weak-base bg-background-base p-3 text-16-regular text-text-weak"
                >
                  <span>{language.t("session.child.promptDisabled")} </span>
                  <Show when={controller.parentID()}>
                    <button
                      type="button"
                      class="text-text-base transition-colors hover:text-text-strong"
                      onClick={controller.openParent}
                    >
                      {language.t("session.child.backToParent")}
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
          </Show>
        </Show>
        <Show when={controller.archived()} keyed>
          {(archived) => (
            <div
              data-component="session-archived"
              class="w-full min-h-16 rounded-[12px] border border-border-weak-base bg-background-base px-4 py-3 flex items-center justify-between gap-3"
            >
              <span class="text-14-regular text-text-weak">{language.t("session.inspector.status.archived")}</span>
              <div class="flex items-center gap-2">
                <Show when={archived.running}>
                  <ButtonV2 variant="neutral" size="normal" onClick={archived.onStop}>
                    {language.t("prompt.action.stop")}
                  </ButtonV2>
                </Show>
                <ButtonV2
                  variant="neutral"
                  size="normal"
                  disabled={archived.restoring || !archived.canRestore}
                  onClick={archived.onRestore}
                >
                  {language.t("workspace.task.restore")}
                </ButtonV2>
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}

function SessionPermissionControl(props: { sessionID: () => string | undefined; onClose: () => void }) {
  const controller = createPromptPermissionController(props.sessionID)
  return <PromptPermissionSelect controller={controller} onClose={props.onClose} />
}
