import type { MergedPullRequest } from "./types"

/** A provider-neutral release lifecycle. Integrations translate their own vocabulary into these phases. */
export const RELEASE_PHASES = ["scheduled", "queued", "testing", "deploying", "verifying", "succeeded", "failed"] as const

export type ReleasePhase = (typeof RELEASE_PHASES)[number]

/** A merged pull request decorated with the release metadata Pasture understands. */
export type ReleasePullRequest = MergedPullRequest & {
  /** Optional provider-specific destinations, such as a service or application name. */
  targets: string[]
  /** Present for work that has reached the release environment. */
  releasedAt?: string
}

export type ReleaseEvent = {
  id: string
  label: string
  environment: string
  phase: ReleasePhase
  startedAt?: string
  updatedAt?: string
  url?: string
  summary?: string
  /** Pull request ids in `owner/repo#123` form. */
  pullRequests: string[]
}

export type ReleaseWindow = {
  active: boolean
  label?: string
  startsAt?: string
  endsAt?: string
}

export type ReleaseFeed = {
  schemaVersion: 1
  generatedAt: string
  window?: ReleaseWindow
  /** Merged into the release branch, but absent from the production marker. */
  waiting: ReleasePullRequest[]
  /** Work verified in the release environment during the provider's chosen lookback. */
  recent: ReleasePullRequest[]
  events: ReleaseEvent[]
}

export type ReleaseSnapshot =
  | { configured: false; scope: string; checkedAt: number }
  | ({ configured: true; scope: string; checkedAt: number; error?: string } & ReleaseFeed)

const MAX_PULL_REQUESTS = 300
const MAX_EVENTS = 30
const MAX_TEXT = 500

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

function text(value: unknown, name: string, required = true): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    if (required) throw new Error(`${name} must be a non-empty string`)
    return undefined
  }
  return value.trim().slice(0, MAX_TEXT)
}

function date(value: unknown, name: string, fallback?: string): string {
  const candidate = text(value, name, false) ?? fallback
  if (!candidate || !Number.isFinite(Date.parse(candidate))) throw new Error(`${name} must be an ISO date`)
  return new Date(candidate).toISOString()
}

function optionalDate(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  return date(value, name)
}

function httpUrl(value: unknown, name: string, required = true): string | undefined {
  const candidate = text(value, name, required)
  if (!candidate) return undefined
  try {
    const url = new URL(candidate)
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error()
    return url.toString()
  } catch {
    throw new Error(`${name} must be an http(s) URL`)
  }
}

function strings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => (typeof item === "string" && item.trim() ? [item.trim().slice(0, MAX_TEXT)] : [])).slice(0, limit)
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function pullRequest(value: unknown, generatedAt: string, name: string): ReleasePullRequest {
  const item = record(value)
  if (!item) throw new Error(`${name} must be an object`)
  const number = nonNegativeNumber(item.number)
  if (!number) throw new Error(`${name}.number must be a positive number`)
  const mergedAt = date(item.mergedAt, `${name}.mergedAt`, generatedAt)
  const releasedAt = optionalDate(item.releasedAt, `${name}.releasedAt`)
  return {
    repo: text(item.repo, `${name}.repo`)!,
    number,
    title: text(item.title, `${name}.title`)!,
    url: httpUrl(item.url, `${name}.url`)!,
    createdAt: date(item.createdAt, `${name}.createdAt`, mergedAt),
    mergedAt,
    author: text(item.author, `${name}.author`)!,
    authorAvatar: item.authorAvatar === null ? null : httpUrl(item.authorAvatar, `${name}.authorAvatar`, false) ?? null,
    mergedBy: item.mergedBy === null ? null : text(item.mergedBy, `${name}.mergedBy`, false) ?? null,
    additions: nonNegativeNumber(item.additions),
    deletions: nonNegativeNumber(item.deletions),
    changedFiles: nonNegativeNumber(item.changedFiles),
    base: text(item.base, `${name}.base`, false) ?? "main",
    labels: strings(item.labels, 30),
    targets: strings(item.targets, 30),
    ...(releasedAt ? { releasedAt } : {}),
  }
}

function releaseEvent(value: unknown, name: string): ReleaseEvent {
  const item = record(value)
  if (!item) throw new Error(`${name} must be an object`)
  const phase = text(item.phase, `${name}.phase`) as ReleasePhase
  if (!RELEASE_PHASES.includes(phase)) throw new Error(`${name}.phase is not supported`)
  return {
    id: text(item.id, `${name}.id`)!,
    label: text(item.label, `${name}.label`)!,
    environment: text(item.environment, `${name}.environment`)!,
    phase,
    startedAt: optionalDate(item.startedAt, `${name}.startedAt`),
    updatedAt: optionalDate(item.updatedAt, `${name}.updatedAt`),
    url: httpUrl(item.url, `${name}.url`, false),
    summary: text(item.summary, `${name}.summary`, false),
    pullRequests: strings(item.pullRequests, MAX_PULL_REQUESTS),
  }
}

function releaseWindow(value: unknown): ReleaseWindow | undefined {
  if (value === undefined || value === null) return undefined
  const item = record(value)
  if (!item || typeof item.active !== "boolean") throw new Error("window.active must be a boolean")
  return {
    active: item.active,
    label: text(item.label, "window.label", false),
    startsAt: optionalDate(item.startsAt, "window.startsAt"),
    endsAt: optionalDate(item.endsAt, "window.endsAt"),
  }
}

/** Validate and normalize the JSON returned by any release integration. */
export function parseReleaseFeed(value: unknown): ReleaseFeed {
  const feed = record(value)
  if (!feed) throw new Error("release feed must be an object")
  if (feed.schemaVersion !== 1) throw new Error("release feed schemaVersion must be 1")
  const generatedAt = date(feed.generatedAt, "generatedAt")
  const waiting = (Array.isArray(feed.waiting) ? feed.waiting : []).slice(0, MAX_PULL_REQUESTS).map((item, index) => pullRequest(item, generatedAt, `waiting[${index}]`))
  const waitingIds = new Set(waiting.map((pr) => `${pr.repo}#${pr.number}`))
  const recent = (Array.isArray(feed.recent) ? feed.recent : [])
    .slice(0, MAX_PULL_REQUESTS)
    .map((item, index) => pullRequest(item, generatedAt, `recent[${index}]`))
    .filter((pr) => !waitingIds.has(`${pr.repo}#${pr.number}`))
  const events = (Array.isArray(feed.events) ? feed.events : []).slice(0, MAX_EVENTS).map((item, index) => releaseEvent(item, `events[${index}]`))
  return { schemaVersion: 1, generatedAt, window: releaseWindow(feed.window), waiting, recent, events }
}

export const releaseIsLive = (phase: ReleasePhase) => phase === "scheduled" || phase === "queued" || phase === "testing" || phase === "deploying" || phase === "verifying"

/** The one event that owns the weather, preferring live work over terminal history. */
export function primaryReleaseEvent(feed: ReleaseFeed, now = Date.now()): ReleaseEvent | undefined {
  for (const phase of ["deploying", "verifying", "testing", "queued", "scheduled"] as const) {
    const live = feed.events.find((event) => event.phase === phase)
    if (live) return live
  }
  const recentTerminal = feed.events.find(
    (event) => (event.phase === "succeeded" || event.phase === "failed") && event.updatedAt && now - Date.parse(event.updatedAt) < 5 * 60_000,
  )
  if (recentTerminal) return recentTerminal
  if (!feed.window?.active) return undefined
  return {
    id: "release-window",
    label: feed.window.label ?? "Release window",
    environment: "production",
    phase: "scheduled",
    startedAt: feed.window.startsAt,
    updatedAt: feed.generatedAt,
    pullRequests: [],
  }
}
