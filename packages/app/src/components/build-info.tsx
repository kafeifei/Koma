import { Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import "./build-info.css"

export function BuildInfo() {
  const platform = usePlatform()
  const language = useLanguage()
  return (
    <Show when={platform.buildInfo}>
      {(build) => (
        <div
          data-component="build-info"
          title={[
            `v${build().version}`,
            build().channel,
            build().commit ? `${build().commit}${build().dirty ? "+" : ""}` : undefined,
            build().builtAt,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          {language.t("app.build", { build: build().id })}
        </div>
      )}
    </Show>
  )
}
