import { createDesktopZoom } from "@opencode-ai/app/desktop/zoom"

export const { webviewZoom, resetZoom, setPinchZoomEnabled, zoomIn, zoomOut } = createDesktopZoom(window.api)
