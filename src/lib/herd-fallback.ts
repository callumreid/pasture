import type { Herd, HerdRequest } from "./pasture/types"

/** A historical slice stays anchored to its original read, never to today's clock. */
export function narrowHerd(source: Herd, input: HerdRequest): Herd | undefined {
  if (source.scope.kind !== input.scope.kind || source.scope.login !== input.scope.login) return undefined
  if (source.days < input.days || (input.openMode === "all" && source.openMode !== "all")) return undefined
  if (!Number.isFinite(source.fetchedAt)) return undefined
  const since = source.fetchedAt - input.days * 86_400_000
  const open = input.openMode === "all" ? source.open : source.open.filter((pr) => Date.parse(pr.updatedAt) >= since)
  const merged = source.merged.filter((pr) => Date.parse(pr.mergedAt) >= since)
  const closed = source.closed.filter((pr) => Date.parse(pr.closedAt) >= since)
  const authors = new Set([...open, ...merged].map((pr) => pr.author))
  return {
    ...source,
    days: input.days,
    openMode: input.openMode,
    open,
    merged,
    closed,
    people: source.people.filter((person) => authors.has(person.login)),
    // A truncated wider search cannot tell us the smaller window's total.
    mergedTotal: source.truncatedMerged ? undefined : merged.length,
    stale: { reason: "Showing a saved herd for this time range while GitHub refreshes." },
  }
}
