import "server-only"
import { derivePrState, type PrCheckState, type PrReviewState } from "@/lib/pr-state"
import type { ClosedPullRequest, Herd, HerdRequest, MergedPullRequest, OpenPullRequest, Person, Scope, Viewer } from "@/lib/pasture/types"
import { readWindow, type WindowIO } from "@/lib/search-plan"

const ENDPOINT = "https://api.github.com/graphql"
/** A page of open pull requests carries reviews, threads and checks, so it is kept small. */
const OPEN_PAGE = 50
const MERGED_PAGE = 100
const CLOSED_PAGE = 100
/** The newest merges kept; a quarter of a busy organization is several thousand. */
export const MAX_MERGED = 10_000
/** Open pull requests kept, in either mode. */
const MAX_OPEN = 3000
const MAX_CLOSED = 2000
/** Concurrent searches per herd read; `MAX_INFLIGHT` caps the whole process regardless. */
const PARALLEL = 8
/**
 * GitHub answers each GraphQL query inside a fixed time budget and fails it with "Resource limits
 * for this query exceeded" when a burst of heavy searches makes it slow, so however many readers
 * are refreshing at once (the herd's three searches, the release observer), this many requests
 * are in flight per process at most.
 */
const MAX_INFLIGHT = 8
/** Slices are never split narrower than this. */
const MIN_SLICE_MS = 15 * 60_000
/** GitHub has no pull requests before this; the floor for "every open PR, however old". */
const DAWN = Date.UTC(2008, 0, 1)

export class GitHubError extends Error {
  status: number
  constructor(message: string, status = 502) {
    super(message)
    this.status = status
  }
}

type GraphQLResponse<T> = { data?: T; errors?: { message?: string; type?: string }[] }

const RETRYABLE = /timeout|something went wrong|resource limits|\b50[234]\b/i

let inflight = 0
const waiting: (() => void)[] = []

/** Run `work` once fewer than `MAX_INFLIGHT` requests are in flight. */
async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (inflight >= MAX_INFLIGHT) await new Promise<void>((resolve) => waiting.push(resolve))
  inflight++
  try {
    return await work()
  } finally {
    inflight--
    waiting.shift()?.()
  }
}

/** Two retries for the flaky failures: GitHub 5xx, a dropped socket, or a query that ran out of GitHub's time budget. */
export async function graphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withSlot(() => graphqlOnce<T>(token, query, variables))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const status = error instanceof GitHubError ? error.status : 0
      if (attempt >= 2 || status === 401 || status === 429 || (status && status < 500 && !RETRYABLE.test(message))) throw error
      await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1) + (/resource limits/i.test(message) ? 1500 : 0)))
    }
  }
}

async function graphqlOnce<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "pasture (https://github.com/callumreid/pasture)",
    },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  })
  if (response.status === 401) throw new GitHubError("GitHub no longer accepts this sign-in. Sign in again.", 401)
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    const hint = /rate limit/i.test(text) ? "GitHub is rate-limiting this token; the field will catch up in a minute." : text.slice(0, 200)
    throw new GitHubError(`GitHub ${response.status}: ${hint || response.statusText}`)
  }
  const parsed = (await response.json()) as GraphQLResponse<T>
  if (parsed.errors?.length) {
    const first = parsed.errors[0]
    if (first?.type === "RATE_LIMITED") throw new GitHubError("GitHub is rate-limiting this token; the field will catch up in a minute.", 429)
    console.error("[pasture] GitHub GraphQL error", first?.message, JSON.stringify(variables).slice(0, 300), query.replace(/\s+/g, " ").slice(0, 160))
    throw new GitHubError(first?.message ?? "GitHub returned an error")
  }
  if (!parsed.data) throw new GitHubError("GitHub returned no data")
  return parsed.data
}

// ---------------------------------------------------------------- who am I

const VIEWER_QUERY = `
query {
  viewer {
    login avatarUrl
    organizations(first: 50) { nodes { login name avatarUrl } }
  }
}`

type RawViewer = {
  viewer: { login: string; avatarUrl: string | null; organizations: { nodes: { login: string; name: string | null; avatarUrl: string | null }[] } }
}

export async function fetchViewer(token: string): Promise<Viewer> {
  const data = await graphql<RawViewer>(token, VIEWER_QUERY, {})
  return {
    login: data.viewer.login,
    avatarUrl: data.viewer.avatarUrl,
    orgs: data.viewer.organizations.nodes.map((org) => ({ login: org.login, name: org.name, avatarUrl: org.avatarUrl })),
  }
}

// ---------------------------------------------------------------- the herd

const OPEN_QUERY = `
query($q: String!, $cursor: String) {
  rateLimit { remaining }
  search(query: $q, type: ISSUE, first: ${OPEN_PAGE}, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title url isDraft createdAt updatedAt baseRefName headRefName
      author { login avatarUrl }
      repository { nameWithOwner isArchived }
      reviewDecision mergeStateStatus isInMergeQueue autoMergeRequest { enabledAt }
      mergeQueueEntry { position }
      labels(first: 20) { nodes { name } }
      reviewRequests(first: 10) { totalCount nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
      latestReviews(first: 10) { nodes { state submittedAt } }
      timelineItems(last: 5, itemTypes: [REVIEW_REQUESTED_EVENT]) { nodes { ... on ReviewRequestedEvent { createdAt } } }
      reviewThreads(first: 50) { nodes { isResolved } }
      commits(last: 1) { nodes { commit { committedDate statusCheckRollup { state } } } }
    } }
  }
}`

const MERGED_QUERY = `
query($q: String!, $cursor: String) {
  rateLimit { remaining }
  search(query: $q, type: ISSUE, first: ${MERGED_PAGE}, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title url mergedAt createdAt baseRefName
      mergeCommit { oid }
      author { login avatarUrl }
      mergedBy { login }
      repository { nameWithOwner isArchived }
      labels(first: 20) { nodes { name } }
    } }
  }
}`

/**
 * The diff of one pull request. Asking for additions and deletions makes a
 * page of pull requests three times slower and pushes a busy search past
 * GitHub's time budget for one query, so the herd is read without them and a
 * lifted cow's are fetched on their own.
 */
const STATS_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { additions deletions changedFiles }
  }
}`

export type PullRequestStats = { additions: number; deletions: number; changedFiles: number }

export async function fetchPullRequestStats(token: string, repo: string, number: number): Promise<PullRequestStats | undefined> {
  const [owner, name] = repo.split("/")
  if (!owner || !name) return undefined
  const data = await graphql<{ repository: { pullRequest: PullRequestStats | null } | null }>(token, STATS_QUERY, { owner, name, number })
  const pr = data.repository?.pullRequest
  return pr ? { additions: pr.additions ?? 0, deletions: pr.deletions ?? 0, changedFiles: pr.changedFiles ?? 0 } : undefined
}

/** Release comparisons only need identity and cow authorship, so keep this much lighter than the main herd query. */
const RELEASE_MERGED_QUERY = `
query($q: String!, $cursor: String) {
  rateLimit { remaining }
  search(query: $q, type: ISSUE, first: ${MERGED_PAGE}, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title url mergedAt createdAt baseRefName mergeCommit { oid }
      author { login avatarUrl }
      mergedBy { login }
      repository { nameWithOwner isArchived }
    } }
  }
}`

const CLOSED_QUERY = `
query($q: String!, $cursor: String) {
  rateLimit { remaining }
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number closedAt
      repository { nameWithOwner isArchived }
    } }
  }
}`

/** How many match, and nothing else: the planner's probe. */
const COUNT_QUERY = `
query($q: String!) {
  rateLimit { remaining }
  search(query: $q, type: ISSUE, first: 1) { issueCount }
}`

type RawClosed = { number: number; closedAt: string; repository: { nameWithOwner: string; isArchived?: boolean | null } }

const isRawClosed = (node: unknown): node is RawClosed =>
  !!node && typeof node === "object" && "closedAt" in node && typeof (node as RawClosed).number === "number"

type RawActor = { login?: string | null; avatarUrl?: string | null } | null

type RawOpen = {
  number: number
  title: string
  url: string
  isDraft: boolean
  createdAt: string
  updatedAt: string
  baseRefName?: string | null
  headRefName?: string | null
  author?: RawActor
  repository: { nameWithOwner: string; isArchived?: boolean | null }
  reviewDecision: string | null
  mergeStateStatus?: string | null
  isInMergeQueue?: boolean | null
  autoMergeRequest?: { enabledAt?: string | null } | null
  mergeQueueEntry?: { position?: number | null } | null
  labels?: { nodes?: { name: string }[] | null } | null
  reviewRequests?: { totalCount?: number; nodes?: ({ requestedReviewer?: { login?: string; name?: string } | null } | null)[] | null } | null
  latestReviews?: { nodes?: { state: string; submittedAt: string }[] | null } | null
  timelineItems?: { nodes?: ({ createdAt?: string } | Record<string, never>)[] | null } | null
  reviewThreads: { nodes: { isResolved: boolean }[] }
  commits: { nodes: { commit: { committedDate?: string; statusCheckRollup: { state: string } | null } }[] }
}

type RawMerged = {
  number: number
  title: string
  url: string
  mergedAt: string
  createdAt: string
  baseRefName?: string | null
  mergeCommit?: { oid?: string | null } | null
  author?: RawActor
  mergedBy?: { login?: string | null } | null
  repository: { nameWithOwner: string; isArchived?: boolean | null }
  labels?: { nodes?: { name: string }[] | null } | null
}

type SearchPage<T> = {
  rateLimit?: { remaining?: number }
  search: { issueCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: (T | Record<string, never>)[] }
}

// `search` returns a union; the `... on PullRequest` fragment leaves anything else as an empty object.
const isRawOpen = (node: unknown): node is RawOpen =>
  !!node && typeof node === "object" && "reviewThreads" in node && typeof (node as RawOpen).number === "number"
const isRawMerged = (node: unknown): node is RawMerged =>
  !!node && typeof node === "object" && "mergedAt" in node && typeof (node as RawMerged).number === "number"

function reviewState(decision: string | null): PrReviewState {
  if (decision === "APPROVED") return "approved"
  if (decision === "CHANGES_REQUESTED") return "changes-requested"
  if (decision === "REVIEW_REQUIRED") return "review-required"
  return "none"
}

function checkState(state: string | null | undefined): PrCheckState {
  switch (state) {
    case "SUCCESS":
      return "success"
    case "FAILURE":
    case "ERROR":
      return "failure"
    case "PENDING":
    case "EXPECTED":
      return "pending"
    default:
      return "none"
  }
}

/**
 * "Changes requested, then the author pushed or re-requested": the reviewer's turn again.
 * GitHub keeps reviewDecision at CHANGES_REQUESTED until the reviewer comes back, so this is
 * derived from timestamps: a review request or head commit newer than the last change request.
 */
function reRequestedAfterChanges(node: RawOpen): boolean {
  const changes = (node.latestReviews?.nodes ?? []).filter((r) => r.state === "CHANGES_REQUESTED").map((r) => Date.parse(r.submittedAt))
  if (!changes.length) return false
  const lastChanges = Math.max(...changes)
  const requests = (node.timelineItems?.nodes ?? []).map((n) => ("createdAt" in n && n.createdAt ? Date.parse(n.createdAt) : 0))
  const lastRequest = requests.length ? Math.max(...requests) : 0
  const head = Date.parse(node.commits.nodes[0]?.commit?.committedDate ?? "") || 0
  const pending = (node.reviewRequests?.totalCount ?? 0) > 0
  return lastRequest > lastChanges || (pending && head > lastChanges)
}

function toOpen(node: RawOpen): OpenPullRequest {
  const unresolvedCount = node.reviewThreads.nodes.reduce((n, t) => (t.isResolved ? n : n + 1), 0)
  const review = reviewState(node.reviewDecision)
  const checks = checkState(node.commits.nodes[0]?.commit?.statusCheckRollup?.state)
  const inMergeQueue = !!node.isInMergeQueue || !!node.mergeQueueEntry
  const reRequested = reRequestedAfterChanges(node)
  const reviewers = (node.reviewRequests?.nodes ?? [])
    .map((request) => request?.requestedReviewer?.login ?? request?.requestedReviewer?.name ?? "")
    .filter(Boolean)
  return {
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: node.title,
    url: node.url,
    isDraft: node.isDraft,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    author: node.author?.login ?? "ghost",
    authorAvatar: node.author?.avatarUrl ?? null,
    review,
    checks,
    unresolvedCount,
    state: derivePrState({ isDraft: node.isDraft, review, checks, unresolvedCount, inMergeQueue, reRequested }),
    inMergeQueue,
    mergeQueuePosition: node.mergeQueueEntry?.position ?? undefined,
    behind: node.mergeStateStatus === "BEHIND",
    autoMerge: !!node.autoMergeRequest,
    reRequested,
    reviewers,
    base: node.baseRefName ?? "main",
    head: node.headRefName ?? "",
    labels: (node.labels?.nodes ?? []).map((label) => label.name),
  }
}

function toMerged(node: RawMerged): MergedPullRequest {
  return {
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: node.title,
    url: node.url,
    createdAt: node.createdAt,
    mergedAt: node.mergedAt,
    author: node.author?.login ?? "ghost",
    authorAvatar: node.author?.avatarUrl ?? null,
    mergedBy: node.mergedBy?.login ?? null,
    base: node.baseRefName ?? "main",
    labels: (node.labels?.nodes ?? []).map((label) => label.name),
    mergeCommit: node.mergeCommit?.oid ?? undefined,
  }
}

/** Search qualifier for the scope: everything in an org, or everything one person wrote. */
export function scopeQualifier(scope: Scope) {
  return scope.kind === "org" ? `org:${scope.login}` : `author:${scope.login}`
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")

type Keyed = { number: number; repository: { nameWithOwner: string; isArchived?: boolean | null } }

/**
 * GitHub answers at most 1000 results per search and pages them one at a
 * time, so a window is read as date slices small enough to page in full,
 * in parallel (see search-plan). Slices never overlap, but the index can
 * shift between pages, so callers still dedupe.
 */
function windowIO<T extends Keyed>(token: string, query: string, base: string, field: "merged" | "updated" | "created" | "closed", keep: (node: unknown) => node is T): WindowIO<T> {
  const q = (from: number, to: number) => `${base} ${field}:${stamp(from)}..${stamp(to)}`
  return {
    async count(from, to) {
      const data = await graphql<{ search: { issueCount: number } }>(token, COUNT_QUERY, { q: q(from, to) })
      return data.search.issueCount
    },
    async page(from, to, cursor) {
      const data = await graphql<SearchPage<T>>(token, query, { q: q(from, to), cursor })
      // GitHub search ignores archived:false for pull requests; drop them here.
      const items = data.search.nodes.filter((node): node is T => keep(node) && !node.repository?.isArchived)
      return { items, hasNextPage: data.search.pageInfo.hasNextPage, endCursor: data.search.pageInfo.endCursor, remaining: data.rateLimit?.remaining }
    },
  }
}

async function searchWindow<T extends Keyed>(
  token: string,
  query: string,
  base: string,
  field: "merged" | "updated" | "created" | "closed",
  from: number,
  to: number,
  keep: (node: unknown) => node is T,
  opts: { pageSize: number; pages: number; budget: number },
) {
  const result = await readWindow(windowIO(token, query, base, field, keep), from, to, {
    target: opts.pageSize * opts.pages,
    minWidth: MIN_SLICE_MS,
    parallel: PARALLEL,
    budget: opts.budget,
    pageSize: opts.pageSize,
  })
  const seen = new Set<string>()
  const items: T[] = []
  for (const item of result.items) {
    const id = `${item.repository.nameWithOwner}#${item.number}`
    if (seen.has(id)) continue
    seen.add(id)
    items.push(item)
  }
  return { items, total: result.total, truncated: result.truncated, remaining: result.remaining }
}

/**
 * A compact merged-only search for release comparisons: the pull requests whose merge commits
 * might sit between production deployments. Unlike the herd query it fetches no open or closed
 * work, and it stops at the newest thousand.
 */
export async function fetchRecentMergedPullRequests(token: string, scope: Scope, days = 30, now = Date.now()) {
  const boundedDays = Math.max(1, Math.min(90, Math.floor(days) || 30))
  const since = now - boundedDays * 86_400_000
  const result = await searchWindow<RawMerged>(token, RELEASE_MERGED_QUERY, `is:pr is:merged ${scopeQualifier(scope)} sort:updated-desc`, "merged", since, now + 60_000, isRawMerged, {
    pageSize: MERGED_PAGE,
    pages: 3,
    budget: 1000,
  })
  const items = result.items.map(toMerged).sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
  return { ...result, items }
}

/** One cow per pull request: open ones in the window (or all of them) and everything merged in the window. */
export async function fetchHerd(token: string, input: HerdRequest, now = Date.now()): Promise<Herd> {
  const days = Math.max(1, Math.min(366, Math.floor(input.days) || 1))
  const since = now - days * 86_400_000
  const where = scopeQualifier(input.scope)
  // Search ranges are inclusive and second-precise; a minute of slack covers clock skew with GitHub.
  const until = now + 60_000
  const openBase = `is:pr is:open ${where} sort:updated-desc`
  const [open, merged, closed] = await Promise.all([
    input.openMode === "active"
      ? searchWindow<RawOpen>(token, OPEN_QUERY, openBase, "updated", since, until, isRawOpen, { pageSize: OPEN_PAGE, pages: 2, budget: MAX_OPEN })
      : searchWindow<RawOpen>(token, OPEN_QUERY, openBase, "created", DAWN, until, isRawOpen, { pageSize: OPEN_PAGE, pages: 2, budget: MAX_OPEN }),
    searchWindow<RawMerged>(token, MERGED_QUERY, `is:pr is:merged ${where} sort:updated-desc`, "merged", since, until, isRawMerged, { pageSize: MERGED_PAGE, pages: 3, budget: MAX_MERGED }),
    // Closed without merging: these cows burn.
    searchWindow<RawClosed>(token, CLOSED_QUERY, `is:pr is:closed is:unmerged ${where} sort:updated-desc`, "closed", since, until, isRawClosed, { pageSize: CLOSED_PAGE, pages: 3, budget: MAX_CLOSED }),
  ])
  const closedItems: ClosedPullRequest[] = closed.items.map((node) => ({ repo: node.repository.nameWithOwner, number: node.number, closedAt: node.closedAt }))
  const openItems = open.items.map(toOpen).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  const mergedAll = merged.items.map(toMerged).sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
  const mergedItems = mergedAll.slice(0, MAX_MERGED)
  const people = new Map<string, Person>()
  for (const pr of [...openItems, ...mergedItems]) {
    if (!people.has(pr.author)) people.set(pr.author, { login: pr.author, avatarUrl: pr.authorAvatar })
  }
  // Thousands of merged cows: their avatars are in `people`, so the answer carries each once.
  for (const pr of mergedItems) pr.authorAvatar = null
  const least = (...values: (number | undefined)[]) => values.reduce<number | undefined>((min, v) => (v === undefined ? min : Math.min(min ?? Infinity, v)), undefined)
  return {
    scope: input.scope,
    days,
    openMode: input.openMode,
    fetchedAt: now,
    open: openItems,
    merged: mergedItems,
    closed: closedItems,
    people: [...people.values()],
    truncatedOpen: open.truncated || undefined,
    truncatedMerged: merged.truncated || mergedAll.length > MAX_MERGED || undefined,
    mergedTotal: merged.total,
    rateLimitRemaining: least(merged.remaining, open.remaining, closed.remaining),
  }
}
