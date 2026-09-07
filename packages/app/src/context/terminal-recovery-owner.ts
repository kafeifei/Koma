export type TerminalFailureSource = "initialization" | "ticket" | "network" | "missing"

export function dispatchTerminalFailure(input: {
  source: TerminalFailureSource
  error: unknown
  report: (error: unknown) => void
  recover: (error: unknown) => void
}) {
  if (input.source === "missing") {
    input.recover(input.error)
    return
  }
  input.report(input.error)
}

export function createTerminalRecoveryOwner<T extends { id: string }>(input: {
  exists: (id: string) => boolean
  create: (id: string) => Promise<T | undefined>
  replace: (id: string, candidate: T) => boolean
  discard: (id: string) => Promise<void>
}) {
  type Owner = {
    id: string
    generation: number
    attempted: boolean
    inflight?: Promise<string | undefined>
  }

  const owners = new Map<string, Owner>()
  const state = { disposed: false }

  const discard = async (candidate: T, previous: string) => {
    if (candidate.id === previous) return
    if (input.exists(candidate.id)) return
    await input.discard(candidate.id)
  }

  const invalidate = (id: string) => {
    const owner = owners.get(id)
    if (!owner) return
    owners.delete(id)
    owner.generation += 1
  }

  const recover = (id: string) => {
    if (state.disposed || !input.exists(id)) return Promise.resolve(undefined)

    const owner = owners.get(id) ?? {
      id,
      generation: 0,
      attempted: false,
    }
    owners.set(id, owner)

    if (owner.inflight) return owner.inflight
    if (owner.attempted) return Promise.resolve(undefined)

    owner.attempted = true
    owner.generation += 1
    const generation = owner.generation
    const pending = Promise.resolve()
      .then(() => input.create(id))
      .then(async (candidate) => {
        if (!candidate?.id) return
        if (candidate.id === id) return id

        const current =
          !state.disposed &&
          owner.id === id &&
          owner.generation === generation &&
          owners.get(id) === owner &&
          input.exists(id)
        if (!current) {
          await discard(candidate, id)
          return
        }

        if (input.exists(candidate.id)) return
        if (!input.replace(id, candidate)) {
          await discard(candidate, id)
          return
        }

        owners.delete(id)
        owner.id = candidate.id
        owner.generation += 1
        owners.set(candidate.id, owner)
        return candidate.id
      })
      .finally(() => {
        if (owner.inflight === pending) owner.inflight = undefined
      })

    owner.inflight = pending
    return pending
  }

  return {
    recover,
    connected(id: string) {
      const owner = owners.get(id)
      if (!owner) return
      owner.generation += 1
      owner.attempted = false
    },
    cancel(id: string) {
      invalidate(id)
    },
    clear() {
      for (const owner of new Set(owners.values())) {
        owner.generation += 1
      }
      owners.clear()
    },
    dispose() {
      state.disposed = true
      for (const owner of new Set(owners.values())) {
        owner.generation += 1
      }
      owners.clear()
    },
  }
}
