import { createMemo, For, Show, type JSX } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Keybind } from "@opencode/ui/keybind"
import { Tooltip } from "@opencode/ui/tooltip"
import { createSessionPanelMenuEntries } from "@/runtime/plugin/panel-menu"
import { useCommand } from "@/shell/commands/command"

function same(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((key, index) => key === b[index])
}

/**
 * Koma: the side panel's launchers as a column of icons at the end of the chat, shown while the panel is closed, so
 * Review, the browser, a terminal and files are each one click away, as in an agent workbench.
 */
export function SessionPanelRail(): JSX.Element {
  const command = useCommand()
  const entries = createSessionPanelMenuEntries()
  const launchers = createMemo(() => entries().filter((entry) => !!entry.item.icon))
  const keys = createMemo(() => launchers().map((entry) => entry.key), [], { equals: same })
  const byKey = createMemo(() => new Map(launchers().map((entry) => [entry.key, entry.item])))

  return (
    <Show when={keys().length > 0}>
      <div
        data-slot="session-panel-rail"
        class="absolute end-2 top-12 z-20 flex flex-col gap-0.5 rounded-[8px] bg-v2-background-bg-base p-0.5"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <For each={keys()}>
          {(key) => (
            <Show when={byKey().get(key)}>
              {(item) => (
                <Tooltip
                  placement="left"
                  gutter={8}
                  value={
                    <>
                      {item().title}
                      <Show when={item().keybind}>
                        {(keybind) => <Keybind keys={command.keybindParts(keybind())} variant="neutral" />}
                      </Show>
                    </>
                  }
                >
                  <IconButton
                    type="button"
                    variant="ghost-muted"
                    data-action="session-panel-rail-item"
                    data-key={key}
                    icon={<Icon name={item().icon ?? "plus"} />}
                    aria-label={item().title}
                    onClick={() => item().run()}
                  />
                </Tooltip>
              )}
            </Show>
          )}
        </For>
      </div>
    </Show>
  )
}
