import { cowID, type ClosedPullRequest, type Herd, type HerdRequest, type MergedPullRequest, type OpenPullRequest, type Person } from "@/lib/pasture/types"

/**
 * A quarter of a busy organization is thousands of merged pull requests, and
 * re-reading them every minute is what empties a GitHub budget. Merged and
 * closed pull requests never change pen, so after one full read the field
 * only asks GitHub what merged or closed since last time and folds that into
 * what it already has. Open pull requests are still read in full every time:
 * a check going green or a review landing is what moves a cow, and GitHub's
 * search cannot be asked for "changed checks" cheaply.
 */

/** The merged and closed lists are read in full this often; between full reads they are topped up. */
export const FULL_READ_MS = 3 * 60 * 60_000
/** A top-up reaches back this far past the last read, for GitHub's search index lag and clock skew. */
export const OVERLAP_MS = 15 * 60_000

/** Whether `previous` is a herd this request can top up instead of reading afresh. */
export function canTopUp(previous: Herd | undefined, input: HerdRequest, now: number): previous is Herd {
  if (!previous) return false
  if (previous.scope.kind !== input.scope.kind || previous.scope.login !== input.scope.login) return false
  if (previous.days !== input.days || previous.openMode !== input.openMode) return false
  const fullReadAt = previous.fullReadAt ?? previous.fetchedAt
  if (!Number.isFinite(fullReadAt) || now - fullReadAt > FULL_READ_MS) return false
  // A clock that went backwards or a herd from the future: read it properly.
  return previous.fetchedAt <= now
}

export type TopUp = {
  open: OpenPullRequest[]
  /** Merged since the last read (with overlap); newest first or any order. */
  merged: MergedPullRequest[]
  closed: ClosedPullRequest[]
  /** GitHub's count for the whole window, when it was asked. */
  mergedTotal?: number
  truncatedOpen?: boolean
  truncatedMerged?: boolean
  rateLimitRemaining?: number
  rateLimitResetAt?: number
}

/** Fold a top-up into the previous herd: new merges join the front, anything older than `since` leaves, people are recounted. */
export function topUp(previous: Herd, fresh: TopUp, now: number, since: number, maxMerged: number): Herd {
  const mergedByID = new Map<string, MergedPullRequest>()
  // The fresh read wins over the remembered copy of the same pull request.
  for (const pr of previous.merged) mergedByID.set(cowID(pr), pr)
  for (const pr of fresh.merged) mergedByID.set(cowID(pr), pr)
  const mergedAll = [...mergedByID.values()]
    .filter((pr) => Date.parse(pr.mergedAt) >= since)
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
  const merged = mergedAll.slice(0, maxMerged)

  const closedByID = new Map<string, ClosedPullRequest>()
  for (const pr of previous.closed) closedByID.set(cowID(pr), pr)
  for (const pr of fresh.closed) closedByID.set(cowID(pr), pr)
  const closed = [...closedByID.values()].filter((pr) => Date.parse(pr.closedAt) >= since).sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt))

  // Avatars: merged cows carry none (see fetchHerd), so remember them from the people list and the fresh reads.
  const avatars = new Map<string, string | null>()
  for (const person of previous.people) avatars.set(person.login, person.avatarUrl)
  for (const pr of [...fresh.merged, ...fresh.open]) if (pr.authorAvatar) avatars.set(pr.author, pr.authorAvatar)
  const people = new Map<string, Person>()
  for (const pr of [...fresh.open, ...merged]) {
    if (!people.has(pr.author)) people.set(pr.author, { login: pr.author, avatarUrl: pr.authorAvatar ?? avatars.get(pr.author) ?? null })
  }
  for (const pr of merged) pr.authorAvatar = null

  return {
    scope: previous.scope,
    days: previous.days,
    openMode: previous.openMode,
    fetchedAt: now,
    fullReadAt: previous.fullReadAt ?? previous.fetchedAt,
    open: fresh.open,
    merged,
    closed,
    people: [...people.values()],
    truncatedOpen: fresh.truncatedOpen || undefined,
    truncatedMerged: previous.truncatedMerged || fresh.truncatedMerged || mergedAll.length > maxMerged || undefined,
    mergedTotal: fresh.mergedTotal ?? Math.max(previous.mergedTotal ?? 0, merged.length),
    rateLimitRemaining: fresh.rateLimitRemaining,
    rateLimitResetAt: fresh.rateLimitResetAt,
  }
}
