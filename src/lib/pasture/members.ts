import { PR_STATE_LABEL } from "@/lib/pr-state"
import { breedFor, cowSeed, type Breed } from "./breeds"
import { penForState, type PenID } from "./pens"
import { cowID, type MergedPullRequest, type OpenPullRequest } from "./types"

/** One cow on the field: an open pull request in a stage pen, or a merged one out back. */
export type PastureMember =
  | { id: string; kind: "open"; pen: PenID; breed: Breed; seed: number; author: string; pr: OpenPullRequest; held: boolean }
  | {
      id: string
      kind: "merged"
      pen: "merged" | "recent"
      release?: "waiting" | "recent"
      breed: Breed
      seed: number
      author: string
      pr: MergedPullRequest & { releasedAt?: string }
    }

/**
 * How long a cow whose PR vanished from the open list stays in its pen,
 * waiting for the merged search to catch up. GitHub's search index lags a
 * merge by a minute or two; past this we assume the PR was closed and the
 * hand of god takes the cow away.
 */
export const LIMBO_MS = 3 * 60_000

export type Held = { pr: OpenPullRequest; since: number }
export type Limbo = Map<string, Held>

/**
 * Advance the limbo: open PRs that dropped out of `open` since `previous` are
 * held; anything that reappears, shows up merged, or times out is let go.
 */
export function advanceLimbo(
  limbo: Limbo,
  previous: OpenPullRequest[],
  open: OpenPullRequest[],
  merged: Set<string>,
  now: number,
  closed: Set<string> = new Set(),
): Limbo {
  const next: Limbo = new Map()
  const current = new Set(open.map(cowID))
  for (const [id, held] of limbo) {
    if (current.has(id) || merged.has(id) || closed.has(id) || now - held.since > LIMBO_MS) continue
    next.set(id, held)
  }
  for (const pr of previous) {
    const id = cowID(pr)
    if (current.has(id) || merged.has(id) || closed.has(id) || next.has(id)) continue
    next.set(id, { pr, since: now })
  }
  return next
}

/** Merged first (newest, capped), then live open PRs, then the held ones. Ids are unique; merged wins a tie. */
export function buildMembers(
  open: OpenPullRequest[],
  merged: MergedPullRequest[],
  limbo: Limbo,
  cap: number,
  recent: MergedPullRequest[] = [],
  releaseMode = false,
): PastureMember[] {
  const members: PastureMember[] = []
  const seen = new Set<string>()
  const mergedCap = Math.max(0, cap - open.length - limbo.size)
  for (const [pr, pen, release] of [
    ...merged.map((item) => [item, "merged", releaseMode ? "waiting" : undefined] as const),
    ...recent.map((item) => [item, "recent", "recent"] as const),
  ].slice(0, mergedCap)) {
    const id = cowID(pr)
    if (seen.has(id)) continue
    seen.add(id)
    members.push({ id, kind: "merged", pen, release, breed: breedFor(pr), seed: cowSeed(pr), author: pr.author, pr })
  }
  for (const pr of open) {
    const id = cowID(pr)
    if (seen.has(id)) continue
    seen.add(id)
    members.push({ id, kind: "open", pen: penForState(pr.state), breed: breedFor(pr), seed: cowSeed(pr), author: pr.author, pr, held: false })
  }
  for (const [id, held] of limbo) {
    if (seen.has(id)) continue
    seen.add(id)
    members.push({
      id,
      kind: "open",
      pen: penForState(held.pr.state),
      breed: breedFor(held.pr),
      seed: cowSeed(held.pr),
      author: held.pr.author,
      pr: held.pr,
      held: true,
    })
  }
  return members.slice(0, cap)
}

export function penCounts(members: PastureMember[]): Record<PenID, number> {
  const counts: Record<PenID, number> = { draft: 0, awaiting: 0, changes: 0, ready: 0, merged: 0, recent: 0 }
  for (const member of members) counts[member.pen]++
  return counts
}

/** Cows per person, most first. */
export function personCounts(members: PastureMember[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const member of members) counts.set(member.author, (counts.get(member.author) ?? 0) + 1)
  return new Map([...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
}

/** A one-line status for an open PR's cow: stage, then whatever is holding it up. */
export function openDetail(pr: OpenPullRequest): string {
  const parts = [PR_STATE_LABEL[pr.state]]
  if (pr.state === "merge-queue" && pr.mergeQueuePosition) parts.push(`position ${pr.mergeQueuePosition}`)
  if (pr.state !== "draft") {
    if (pr.review === "approved") parts.push("approved")
    else if (pr.review === "changes-requested" && pr.state !== "changes-requested") parts.push("changes requested")
    if (pr.checks === "failure") parts.push("CI failing")
    else if (pr.checks === "pending") parts.push("CI running")
    else if (pr.checks === "success") parts.push("CI green")
    if (pr.unresolvedCount > 0) parts.push(`${pr.unresolvedCount} unresolved`)
  }
  if (pr.behind) parts.push("behind base")
  if (pr.autoMerge) parts.push("auto-merge armed")
  return parts.join(" · ")
}
