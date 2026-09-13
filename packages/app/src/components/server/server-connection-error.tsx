import { Show } from "solid-js"

export function ServerConnectionError(props: {
  message: string
  retryLabel: string
  removeLabel: string
  pending: boolean
  onRetry(): void
  onRemove?: () => void
}) {
  return (
    <div data-slot="workspace-empty" role="alert">
      {props.message}
      <button type="button" data-slot="workspace-action" disabled={props.pending} onClick={props.onRetry}>
        {props.retryLabel}
      </button>
      <Show when={props.onRemove}>
        <button type="button" data-slot="workspace-action" onClick={() => props.onRemove?.()}>
          {props.removeLabel}
        </button>
      </Show>
    </div>
  )
}
