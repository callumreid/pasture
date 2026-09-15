import "server-only"
import { derivePrState, type PrCheckState, type PrReviewState } from "@/lib/pr-state"
import type { ClosedPullRequest, Herd, HerdRequest, MergedPullRequest, OpenPullRequest, Person, Scope, Viewer } from "@/lib/pasture/types"

const ENDPOINT = "https://api.github.com/graphql"
const OPEN_PAGE = 50
const MAX_OPEN_PAGES = 4
const MERGED_PAGE = 100
/** The newest merges kept after every slice has answered; the field caps lower than this anyway. */
const MAX_MERGED = 400

export class GitHubError extends Error {
  status: number
  constructor(message: string, status = 502) {
    super(message)
    this.status = status
  }
}

type GraphQLResponse<T> = { data?: T; errors?: { message?: string; type?: string }[] }

const RETRYABLE = /timeout|something went wrong|\b50[234]\b/i

/** One retry for the flaky failures: GitHub 5xx, a dropped socket, or a search that timed out server-side. */
export async function graphql<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
  try {
    return await graphqlOnce<T>(token, query, variables)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = error instanceof GitHubError ? error.status : 0
    if (status === 401 || status === 429 || (status && status < 500 && !RETRYABLE.test(message))) throw error
    await new Promise((resolve) => setTimeout(resolve, 700))
    return graphqlOnce<T>(token, query, variables)
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
      number title url isDraft createdAt updatedAt additions deletions changedFiles baseRefName headRefName
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
      number title url mergedAt createdAt additions deletions changedFiles baseRefName
      mergeCommit { oid }
      author { login avatarUrl }
      mergedBy { login }
      repository { nameWithOwner isArchived }
      labels(first: 20) { nodes { name } }
    } }
  }
}`

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
  additions?: number | null
  deletions?: number | null
  changedFiles?: number | null
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
  additions?: number | null
  deletions?: number | null
  changedFiles?: number | null
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
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    changedFiles: node.changedFiles ?? 0,
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
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    changedFiles: node.changedFiles ?? 0,
    base: node.baseRefName ?? "main",
    labels: (node.labels?.nodes ?? []).map((label) => label.name),
    mergeCommit: node.mergeCommit?.oid ?? undefined,
  }
}

/** Search qualifier for the scope: everything in an org, or everything one person wrote. */
export function scopeQualifier(scope: Scope) {
  return scope.kind === "org" ? `org:${scope.login}` : `author:${scope.login}`
}

async function searchAll<T>(
  token: string,
  query: string,
  q: string,
  pages: number,
  keep: (node: unknown) => node is T,
): Promise<{ items: T[]; truncated: boolean; remaining?: number }> {
  const items: T[] = []
  let cursor: string | null = null
  let truncated = false
  let remaining: number | undefined
  for (let page = 0; page < pages; page++) {
    const data: SearchPage<T> = await graphql<SearchPage<T>>(token, query, { q, cursor })
    remaining = data.rateLimit?.remaining ?? remaining
    for (const node of data.search.nodes) {
      // GitHub search ignores archived:false for pull requests; drop them here.
      if (!keep(node) || (node as { repository?: { isArchived?: boolean | null } }).repository?.isArchived) continue
      items.push(node)
    }
    const info = data.search.pageInfo
    if (!info.hasNextPage || !info.endCursor) break
    cursor = info.endCursor
    if (page === pages - 1) truncated = true
  }
  return { items, truncated, remaining }
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")

/**
 * GitHub pages a search sequentially and a big page of pull requests with
 * reviews and checks takes seconds, so the window is cut into slices that
 * are searched in parallel. Slices meet at a shared second and search ranges
 * are inclusive, so the same PR can come back twice; callers dedupe.
 */
async function slicedSearch<T extends { number: number; repository: { nameWithOwner: string } }>(
  token: string,
  query: string,
  base: string,
  field: "merged" | "updated",
  since: number,
  now: number,
  slices: number,
  pagesPerSlice: number,
  keep: (node: unknown) => node is T,
) {
  const step = (now - since) / slices
  const results = await Promise.all(
    Array.from({ length: slices }, (_, i) => {
      const from = stamp(since + step * i)
      const to = stamp(i === slices - 1 ? now + 60_000 : since + step * (i + 1))
      return searchAll<T>(token, query, `${base} ${field}:${from}..${to}`, pagesPerSlice, keep)
    }),
  )
  const seen = new Set<string>()
  const items: T[] = []
  for (const result of results) {
    for (const item of result.items) {
      const id = `${item.repository.nameWithOwner}#${item.number}`
      if (seen.has(id)) continue
      seen.add(id)
      items.push(item)
    }
  }
  return {
    items,
    truncated: results.some((result) => result.truncated),
    remaining: results.reduce<number | undefined>((min, result) => (result.remaining === undefined ? min : Math.min(min ?? Infinity, result.remaining)), undefined),
  }
}

/** Shorter windows get finer slices; the cost is one search per slice per refresh. */
const sliceCount = (days: number) => Math.min(8, Math.max(3, Math.ceil(days * 4)))

/** A compact merged-only search for release comparisons; unlike the herd query it does not fetch open or closed work. */
export async function fetchRecentMergedPullRequests(token: string, scope: Scope, days = 30, now = Date.now()) {
  const boundedDays = Math.max(1, Math.min(90, Math.floor(days) || 30))
  const since = now - boundedDays * 86_400_000
  const result = await searchAll<RawMerged>(
    token,
    RELEASE_MERGED_QUERY,
    `is:pr is:merged ${scopeQualifier(scope)} merged:>=${stamp(since)} sort:updated-desc`,
    4,
    isRawMerged,
  )
  const allItems = result.items.map(toMerged).sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
  return { ...result, items: allItems.slice(0, MAX_MERGED), truncated: result.truncated || allItems.length > MAX_MERGED }
}

/** One cow per pull request: open ones in the window (or all of them) and everything merged in the window. */
export async function fetchHerd(token: string, input: HerdRequest, now = Date.now()): Promise<Herd> {
  const days = Math.max(1, Math.min(366, Math.floor(input.days) || 1))
  const since = now - days * 86_400_000
  const where = scopeQualifier(input.scope)
  const slices = sliceCount(days)
  const [open, merged, closed] = await Promise.all([
    input.openMode === "active"
      ? slicedSearch<RawOpen>(token, OPEN_QUERY, `is:pr is:open ${where} sort:updated-desc`, "updated", since, now, slices, 2, isRawOpen)
      : searchAll<RawOpen>(token, OPEN_QUERY, `is:pr is:open ${where} sort:updated-desc`, MAX_OPEN_PAGES, isRawOpen),
    slicedSearch<RawMerged>(token, MERGED_QUERY, `is:pr is:merged ${where} sort:updated-desc`, "merged", since, now, slices, 2, isRawMerged),
    // Closed without merging: these cows burn. Rare enough for a single page.
    searchAll<RawClosed>(token, CLOSED_QUERY, `is:pr is:closed is:unmerged ${where} closed:>=${stamp(since)} sort:updated-desc`, 1, isRawClosed),
  ])
  const closedItems: ClosedPullRequest[] = closed.items.map((node) => ({ repo: node.repository.nameWithOwner, number: node.number, closedAt: node.closedAt }))
  const openItems = open.items.map(toOpen).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
  const mergedAll = merged.items.map(toMerged).sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
  const mergedItems = mergedAll.slice(0, MAX_MERGED)
  const people = new Map<string, Person>()
  for (const pr of [...openItems, ...mergedItems]) {
    if (!people.has(pr.author)) people.set(pr.author, { login: pr.author, avatarUrl: pr.authorAvatar })
  }
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
    rateLimitRemaining: merged.remaining ?? open.remaining,
  }
}
