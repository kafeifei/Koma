import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { localRemoteDevices } from "./local-devices"

test("recognizes sibling hosts while retaining per-client listener ownership without exporting credentials", () => {
  const profile = mkdtempSync(join(tmpdir(), "koma-local-devices-"))
  const save = (path: string, value: object) => {
    mkdirSync(join(profile, path, ".."), { recursive: true })
    writeFileSync(join(profile, path), JSON.stringify(value))
  }
  try {
    save("desktop/opencode.settings", {
      remoteDeviceID: "electron",
      remoteTunnels: { account: { clusterId: "use2", tunnelId: "this-electron", port: 4100 } },
      remoteClientPorts: { "jpe1/this-tauri": 4200, "use1/another-computer": 4300 },
      remoteCredential: "must-not-be-exported",
    })
    save("bin/.koma-instances/tauri/desktop/settings.json", {
      remoteDeviceID: "tauri",
      remoteTunnels: { account: { clusterId: "jpe1", tunnelId: "this-tauri", port: 4400 } },
      remoteClientPorts: { "use2/this-electron": 4500 },
    })
    writeFileSync(join(profile, "bin/.koma-instances/.DS_Store"), "ignored")
    const current = {
      remoteDeviceID: "tauri",
      remoteClientPorts: { "use1/another-computer": 4600 },
      remoteTunnels: { account: { clusterId: "jpe1", tunnelId: "this-tauri", port: 4400 } },
    }
    const state = localRemoteDevices({ get: (key) => Reflect.get(current, key) }, profile)
    expect([...state.ids].sort()).toEqual(["jpe1/this-tauri", "use2/this-electron"])
    expect(state.connections).toEqual([
      { id: "jpe1/this-tauri", clientID: "electron", url: "http://127.0.0.1:4200", current: true },
      { id: "use1/another-computer", clientID: "electron", url: "http://127.0.0.1:4300", current: false },
      { id: "use1/another-computer", clientID: "tauri", url: "http://127.0.0.1:4600", current: false },
    ])
    expect(JSON.stringify(state)).not.toContain("must-not-be-exported")
  } finally {
    rmSync(profile, { recursive: true, force: true })
  }
})
