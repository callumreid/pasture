import "server-only"
import { fetchGitHubReleaseFeed, githubReleaseConfigured } from "@/lib/github-release-server"
import { parseReleaseFeed, type ReleaseFeed } from "@/lib/pasture/releases"

const KEEP_MS = 5_000
const MAX_BYTES = 1_000_000

type Cached = { at: number; feed: ReleaseFeed }
const cache = new Map<string, Cached>()
const inflight = new Map<string, Promise<ReleaseFeed>>()

export function releaseScopes(): string[] {
  const configured = process.env.PASTURE_RELEASE_SCOPES || process.env.PASTURE_DEFAULT_ORG || ""
  return configured
    .split(",")
    .map((scope) => scope.trim().toLowerCase())
    .filter(Boolean)
}

export function releaseSourceConfigured() {
  return Boolean((githubReleaseConfigured() || process.env.PASTURE_RELEASE_FEED_URL) && releaseScopes().length)
}

async function read(scope: string): Promise<ReleaseFeed> {
  const rawUrl = process.env.PASTURE_RELEASE_FEED_URL
  if (!rawUrl) throw new Error("release feed is not configured")
  const url = new URL(rawUrl)
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("release feed URL must use http(s)")
  const headers: HeadersInit = { accept: "application/json", "x-pasture-scope": scope }
  if (process.env.PASTURE_RELEASE_FEED_TOKEN) headers.authorization = `Bearer ${process.env.PASTURE_RELEASE_FEED_TOKEN}`
  const response = await fetch(url, { cache: "no-store", headers, signal: AbortSignal.timeout(8_000) })
  if (!response.ok) throw new Error(`release feed answered ${response.status}`)
  const declared = Number(response.headers.get("content-length"))
  if (declared > MAX_BYTES) throw new Error("release feed is too large")
  const body = await response.text()
  if (body.length > MAX_BYTES) throw new Error("release feed is too large")
  return parseReleaseFeed(JSON.parse(body) as unknown)
}

/** Fetch one scope's provider-neutral release feed, sharing very frequent browser polls. */
export async function fetchReleaseFeed(scope: string): Promise<ReleaseFeed> {
  const cached = cache.get(scope)
  if (cached && Date.now() - cached.at < KEEP_MS) return cached.feed
  const running = inflight.get(scope)
  if (running) return running
  const promise = read(scope)
    .then((feed) => {
      cache.set(scope, { at: Date.now(), feed })
      return feed
    })
    .finally(() => inflight.delete(scope))
  inflight.set(scope, promise)
  return promise
}

/** Prefer the built-in GitHub observer; the HTTP contract remains an escape hatch for other systems. */
export function fetchReleaseSource(token: string, scope: string): Promise<ReleaseFeed> {
  return githubReleaseConfigured() ? fetchGitHubReleaseFeed(token, scope) : fetchReleaseFeed(scope)
}
