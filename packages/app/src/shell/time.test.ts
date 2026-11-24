import { afterEach, expect, setSystemTime, test } from "bun:test"
import { getCompactTime, getRelativeTime } from "./time"

const now = new Date(2026, 8, 22, 12)

const t = (key: string, params?: Record<string, string | number>) => `${key}:${params?.count ?? ""}`

afterEach(() => {
  setSystemTime()
})

test.each([
  [30_000, "common.time.justNow:"],
  [5 * 60_000, "common.time.minutesAgo.short:5"],
  [3 * 3_600_000, "common.time.hoursAgo.short:3"],
  [6 * 86_400_000, "common.time.daysAgo.short:6"],
  [7 * 86_400_000, "Sep 15"],
  [400 * 86_400_000, "Aug 18, 2025"],
])("formats %pms ago", (ago, expected) => {
  setSystemTime(now)

  expect(getRelativeTime(new Date(now.getTime() - ago).toISOString(), t, "en-US")).toBe(expected)
})

test.each([
  [-5_000, "common.time.compact.now:"],
  [59_000, "common.time.compact.now:"],
  [5 * 60_000, "common.time.compact.minutes:5"],
  [3 * 3_600_000, "common.time.compact.hours:3"],
  [6 * 86_400_000, "common.time.compact.days:6"],
  [7 * 86_400_000, "common.time.compact.weeks:1"],
  [364 * 86_400_000, "common.time.compact.weeks:52"],
  [400 * 86_400_000, "common.time.compact.years:1"],
])("abbreviates %pms ago to one unit", (ago, expected) => {
  setSystemTime(now)

  expect(getCompactTime(now.getTime() - ago, t)).toBe(expected)
})
