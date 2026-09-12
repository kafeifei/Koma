import { type ComponentProps } from "solid-js"

const mark = "M2 1H6V8L12 1H17L9 10L17 19H12L6 12V19H2Z"
export const Mark = (props: { class?: string }) => (
  <svg
    data-component="logo-mark"
    class={props.class}
    viewBox="0 0 18 20"
    fill="var(--icon-strong-base)"
    xmlns="http://www.w3.org/2000/svg"
    aria-label="Koma"
  >
    <path d={mark} />
  </svg>
)
export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => (
  <svg
    ref={props.ref}
    data-component="logo-splash"
    class={props.class}
    viewBox="0 0 18 20"
    fill="var(--icon-strong-base)"
    xmlns="http://www.w3.org/2000/svg"
    aria-label="Koma"
  >
    <path d={mark} />
  </svg>
)
export const Logo = (props: { class?: string }) => (
  <svg class={props.class} viewBox="0 0 128 42" xmlns="http://www.w3.org/2000/svg" aria-label="Koma">
    <text
      x="0"
      y="33"
      font-family="system-ui, sans-serif"
      font-size="38"
      font-weight="650"
      fill="var(--icon-strong-base)"
    >
      Koma
    </text>
  </svg>
)
