import { expect, test } from "bun:test"
import type { Tunnel, NamedRateStatus } from "@microsoft/dev-tunnels-contracts"
import { listRemoteRegistrations, removeRemoteRegistration, getRemoteQuota } from "../src/desktop/remote-registrations"
import { REMOTE_LABEL, toRemoteDevice } from "../src/tunnels"

const localID = "33c48177-63c4-4135-8218-c0b6ab2211ed"
const guard = () => ({ deviceID: localID, check() {} })
const registration = (): Tunnel => ({
  clusterId: "usw2",
  tunnelId: "koma-test-device",
  description: "Debug device",
  labels: [REMOTE_LABEL],
  status: { hostConnectionCount: 0 },
  ports: [],
  accessTokens: { manage: "private-token" },
})
function fixture(data = registration()) {
  const calls: string[] = []
  return {
    calls,
    client: {
      listTunnels: async () => {
        calls.push("list")
        return [data]
      },
      getTunnel: async () => {
        calls.push("get")
        return data
      },
      deleteTunnel: async () => {
        calls.push("delete")
        return true
      },
    },
  }
}
const id = "usw2/koma-test-device"

test("incomplete offline registrations remain manageable without becoming connectable or exposing credentials", async () => {
  const { client } = fixture()
  const items = await listRemoteRegistrations(client)
  expect(items).toMatchObject([{ id, name: "Debug device", online: false, connectable: false }])
  expect(toRemoteDevice(registration())).toBeUndefined()
  expect(JSON.stringify(items)).not.toContain("private-token")
})

test("cleanup rehydrates the owned registration, then deletes the cloud resource even when it has no ports", async () => {
  const { client, calls } = fixture()
  expect(await removeRemoteRegistration(client, id, guard())).toBe("deleted")
  expect(calls).toEqual(["list", "get", "delete"])
})

test.each([1, { current: 1 }, undefined, { current: -1 }, NaN])(
  "a newly online or unknown host is never deleted (%j)",
  async (hosts) => {
    const input = fixture()
    input.client.getTunnel = async () => ({ ...registration(), status: { hostConnectionCount: hosts } })
    const result = await removeRemoteRegistration(input.client, id, guard())
    expect(result).toBe(hosts === 1 || (typeof hosts === "object" && hosts?.current === 1) ? "online" : "unknown")
    expect(input.calls).not.toContain("delete")
  },
)

test("protects this profile by its label when the local saved tunnel record is missing", async () => {
  const input = fixture({ ...registration(), labels: [REMOTE_LABEL, `opencode-device-${localID.replaceAll("-", "")}`] })
  expect(await removeRemoteRegistration(input.client, id, guard())).toBe("protected")
  expect(input.calls).not.toContain("delete")
})

test("protects the current tunnel before issuing any management request", async () => {
  const input = fixture()
  expect(await removeRemoteRegistration(input.client, id, { ...guard(), currentID: id })).toBe("protected")
  expect(input.calls).toEqual([])
})

test("never fetches or deletes another product from the owner directory", async () => {
  const input = fixture({ ...registration(), labels: ["another-product"] })
  expect(await listRemoteRegistrations(input.client)).toEqual([])
  expect(await removeRemoteRegistration(input.client, id, guard())).toBe("missing")
  expect(input.calls).toEqual(["list", "list"])
})

test("a changed identity or removed product label blocks deletion", async () => {
  for (const patch of [{ tunnelId: "different-device" }, { labels: [] }]) {
    const input = fixture()
    input.client.getTunnel = async () => ({ ...registration(), ...patch })
    expect(["failed", "protected"]).toContain(await removeRemoteRegistration(input.client, id, guard()))
    expect(input.calls).not.toContain("delete")
  }
})

test("cancellation during ownership lookup prevents delete dispatch", async () => {
  const input = fixture()
  let cancelled = false
  input.client.listTunnels = async () => {
    cancelled = true
    return [registration()]
  }
  expect(
    await removeRemoteRegistration(input.client, id, {
      deviceID: localID,
      check() {
        if (cancelled) throw Error("cancelled")
      },
    }),
  ).toBe("failed")
  expect(input.calls).not.toContain("delete")
})

test("a disappeared registration is idempotent, while arbitrary SDK errors remain sanitized", async () => {
  const input = fixture()
  input.client.getTunnel = async () => {
    throw { response: { status: 404 } }
  }
  expect(await removeRemoteRegistration(input.client, id, guard())).toBe("missing")
  expect(await listRemoteRegistrations(input.client)).toEqual([])
  input.client.getTunnel = async () => {
    throw { message: "private-token", response: { status: 403 } }
  }
  expect(await removeRemoteRegistration(input.client, id, guard())).toBe("failed")
  await expect(listRemoteRegistrations(input.client)).rejects.toThrow("Remote directory unavailable")
})

test("invalid input cannot issue a delete request", async () => {
  for (const bad of ["../device", "usw2/koma-test-device/extra", "usw2/x"]) {
    const input = fixture()
    expect(await removeRemoteRegistration(input.client, bad, guard())).toBe("failed")
    expect(input.calls).toEqual([])
  }
})

test("quota uses authoritative count and limit, never a filtered device count or unrelated limit", async () => {
  expect(
    await getRemoteQuota({
      listUserLimits: async () => [{ name: "TunnelsPerUserPerLocation", current: 10, limit: 10 }],
    }),
  ).toEqual({ current: 10, limit: 10 })
  for (const limits of [
    [],
    [{ name: "Bandwidth", current: 1, limit: 5 }],
    [{ name: "TunnelsPerUserPerLocation", current: NaN, limit: 10 }],
    [{ name: "TunnelsPerUserPerLocation", limit: 10 }],
  ]) {
    expect(await getRemoteQuota({ listUserLimits: async () => limits as unknown as NamedRateStatus[] })).toBeNull()
  }
})
