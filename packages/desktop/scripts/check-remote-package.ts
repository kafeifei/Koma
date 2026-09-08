import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"

export async function checkRemotePackage(app: string, executableName: string) {
  // Resolve from the archive, not this checkout: peer dependencies can exist in
  // the development workspace while being omitted from the packaged app.
  const script = `
    const { createRequire } = require("node:module")
    const archiveRequire = createRequire(process.argv[1])
    const { TunnelManagementHttpClient, ManagementApiVersions } = archiveRequire("@microsoft/dev-tunnels-management")
    const { TunnelRelayTunnelHost, TunnelRelayTunnelClient } = archiveRequire("@microsoft/dev-tunnels-connections")
    const management = new TunnelManagementHttpClient(
      { name: "OpenCode-Lab-package-check", version: "1.0" },
      ManagementApiVersions.Version20230927preview,
      async () => undefined,
    )
    const host = new TunnelRelayTunnelHost(management)
    const client = new TunnelRelayTunnelClient(management)
    Promise.all([host.dispose(), client.dispose()]).catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
  `
  await promisify(execFile)(
    join(app, "Contents", "MacOS", executableName),
    ["-e", script, join(app, "Contents", "Resources", "app.asar", "out", "main", "index.js")],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000 },
  )
}
