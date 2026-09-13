export function terminalConnectTicket(
  result: { response?: Response; data?: { ticket?: string }; error?: unknown } | undefined,
  messages: { csrf: () => string; status: (status: number) => string; network: () => string },
) {
  if (!result) return undefined
  // The SDK returns { error, response: undefined } when fetch fails with
  // throwOnError:false. That is a transport failure, not an HTTP status.
  if (!result.response) throw result.error ?? new Error(messages.network())
  const status = result.response.status
  if (status === 200 && result.data?.ticket) return result.data.ticket
  if (status === 404 || status === 405) return undefined
  if (status === 403) throw new Error(messages.csrf())
  throw new Error(messages.status(status))
}
