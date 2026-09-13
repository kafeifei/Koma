import { Suspense, type ParentProps } from "solid-js"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { useLanguage } from "@/context/language"

export function SettingsPanelV2(props: ParentProps<{ value: string }>) {
  const language = useLanguage()
  return (
    <TabsV2.Content value={props.value} class="settings-v2-panel">
      {/* Dialogs inherit the workspace owner. Contain every settings request in its panel. */}
      <Suspense
        fallback={
          <div class="p-6 text-12-regular text-text-weak" role="status">
            {language.t("common.loading")}
          </div>
        }
      >
        {props.children}
      </Suspense>
    </TabsV2.Content>
  )
}
