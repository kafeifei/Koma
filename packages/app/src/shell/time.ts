type TimeKey =
  | "common.time.justNow"
  | "common.time.minutesAgo.short"
  | "common.time.hoursAgo.short"
  | "common.time.daysAgo.short"

type Translate = (key: TimeKey, params?: Record<string, string | number>) => string

export function getRelativeTime(dateString: string, t: Translate, locale: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSeconds = Math.floor(diffMs / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSeconds < 60) return t("common.time.justNow")

  if (diffMinutes < 60) return t("common.time.minutesAgo.short", { count: diffMinutes })

  if (diffHours < 24) return t("common.time.hoursAgo.short", { count: diffHours })

  if (diffDays < 7) return t("common.time.daysAgo.short", { count: diffDays })

  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(date)
}

type CompactTimeKey =
  | "common.time.compact.now"
  | "common.time.compact.minutes"
  | "common.time.compact.hours"
  | "common.time.compact.days"
  | "common.time.compact.weeks"
  | "common.time.compact.years"

type TranslateCompact = (key: CompactTimeKey, params?: Record<string, string | number>) => string

/** Koma: the age of a timestamp in one short unit ("5m", "3h", "2d"), for a list row's trailing label. */
export function getCompactTime(timestamp: number, t: TranslateCompact): string {
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000)

  if (minutes < 1) return t("common.time.compact.now")

  if (minutes < 60) return t("common.time.compact.minutes", { count: minutes })
  const hours = Math.floor(minutes / 60)

  if (hours < 24) return t("common.time.compact.hours", { count: hours })
  const days = Math.floor(hours / 24)

  if (days < 7) return t("common.time.compact.days", { count: days })

  if (days < 365) return t("common.time.compact.weeks", { count: Math.floor(days / 7) })

  return t("common.time.compact.years", { count: Math.floor(days / 365) })
}
