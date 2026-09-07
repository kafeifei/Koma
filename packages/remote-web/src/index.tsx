import { render } from "solid-js/web"
import { App } from "./app"
import "./styles.css"

const root = document.getElementById("root")
if (!(root instanceof HTMLElement)) throw new Error("Remote Web root element is missing")
render(() => <App />, root)
