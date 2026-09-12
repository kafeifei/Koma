import { desktopIdentity } from "../src/main/channel"
import { resolveChannel } from "./utils"

const channel = resolveChannel(process.argv[2])

const appId = desktopIdentity(channel, process.env.KOMA_RELEASE === "1").appId
const productName = desktopIdentity(channel, process.env.KOMA_RELEASE === "1").name
const summary = `Desktop Agent workbench${channel !== "prod" ? ` (${channel})` : ""}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="com.kafeifei">
    <name>kafeifei</name>
  </developer>

  <description>
    <p>
      Koma is a desktop Agent workbench built on OpenCode.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="bugtracker">https://github.com/kafeifei/Koma/issues</url>
  <url type="homepage">https://github.com/kafeifei/Koma</url>
  <url type="vcs-browser">https://github.com/kafeifei/Koma</url>

  <screenshots>
    <screenshot type="default">
      <image>https://raw.githubusercontent.com/anomalyco/opencode/b75d4d1c5ec449585d515c756fc81f080a157a9a/packages/web/src/assets/lander/screenshot.png</image>
    </screenshot>
  </screenshots>
</component>
`

await Bun.write(`resources/${appId}.metainfo.xml`, xml)
console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
