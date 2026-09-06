import { OpenInAppV2 } from "@/components/session/open-in-app-v2"
import { joinPickerPath, pickerRoot } from "@/components/directory-picker-domain"

export function FilePanelToolbar(props: { directory: () => string; file: () => string }) {
  const path = () => (pickerRoot(props.file()) ? props.file() : joinPickerPath(props.directory(), props.file()))

  return (
    <div data-component="file-panel-toolbar" class="flex items-center">
      <OpenInAppV2 directory={props.directory} file={path} />
    </div>
  )
}
