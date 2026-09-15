import type { PrCheckState, PrReviewState, PrState } from "@/lib/pr-state"

export type PastureTimeframe = { id: "day" | "week" | "month" | "quarter"; label: string; days: number }

export const PASTURE_TIMEFRAMES: PastureTimeframe[] = [
  { id: "day", label: "24 hours", days: 1 },
  { id: "week", label: "7 days", days: 7 },
  { id: "month", label: "30 days", days: 30 },
  { id: "quarter", label: "90 days", days: 90 },
]

/** Which open pull requests graze: only the ones touched inside the window, or every open one. */
export type OpenMode = "active" | "all"

/** Somebody with a pull request on the field. */
export type Person = { login: string; avatarUrl: string | null }

export type OpenPullRequest = {
  repo: string
  number: number
  title: string
  url: string
  isDraft: boolean
  createdAt: string
  updatedAt: string
  author: string
  authorAvatar: string | null
  review: PrReviewState
  checks: PrCheckState
  unresolvedCount: number
  state: PrState
  /** GitHub merge queue membership and position (1 = next). */
  inMergeQueue: boolean
  mergeQueuePosition?: number
  /** The branch is behind its base. */
  behind: boolean
  /** GitHub auto-merge is armed; it merges or queues when green. */
  autoMerge: boolean
  /** Changes were requested, then a newer commit or re-request happened; the reviewer's turn again. */
  reRequested: boolean
  /** Logins (or team names) whose review is still requested. */
  reviewers: string[]
  additions: number
  deletions: number
  changedFiles: number
  base: string
  head: string
  labels: string[]
}

export type MergedPullRequest = {
  repo: string
  number: number
  title: string
  url: string
  createdAt: string
  mergedAt: string
  author: string
  authorAvatar: string | null
  mergedBy: string | null
  additions: number
  deletions: number
  changedFiles: number
  base: string
  labels: string[]
  /** GitHub's merge commit, when a caller needs to compare the PR with a deployed SHA. */
  mergeCommit?: string
}

/** A pull request closed without merging inside the window: its cow burns. */
export type ClosedPullRequest = { repo: string; number: number; closedAt: string }

export type PullRequest = OpenPullRequest | MergedPullRequest

/** Whose pull requests: an organization, or the signed-in person across everything they touch. */
export type Scope = { kind: "org"; login: string } | { kind: "me"; login: string }

export type HerdRequest = { scope: Scope; days: number; openMode: OpenMode }

export type Herd = {
  scope: Scope
  days: number
  openMode: OpenMode
  fetchedAt: number
  open: OpenPullRequest[]
  merged: MergedPullRequest[]
  closed: ClosedPullRequest[]
  people: Person[]
  /** More matched than were fetched; the field shows the newest. */
  truncatedOpen?: boolean
  truncatedMerged?: boolean
  rateLimitRemaining?: number
}

export type OrgSummary = { login: string; name: string | null; avatarUrl: string | null }

export type Viewer = { login: string; avatarUrl: string | null; orgs: OrgSummary[] }

export const cowID = (pr: Pick<PullRequest, "repo" | "number">) => `${pr.repo}#${pr.number}`
