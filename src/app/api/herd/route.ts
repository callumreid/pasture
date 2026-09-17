import { createHash } from "node:crypto"
import { NextResponse, after } from "next/server"
import { fetchHerd, fetchViewer, GitHubError } from "@/lib/github"
import type { Herd, OpenMode, Scope } from "@/lib/pasture/types"
import { resolveToken } from "@/lib/token"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
// A GitHub search over a busy organization takes several seconds; the platform default of ten is too tight.
export const maxDuration = 60

const SCOPE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

/**
 * GitHub takes several seconds to answer a search over a busy organization,
 * so the last answer is kept for a few minutes per person and field. A read
 * older than `STALE_MS` is served straight away and refreshed after the
 * response has gone out, so the field paints at once and catches up quietly.
 */
const KEEP_MS = 5 * 60_000
const STALE_MS = 45_000

type Entry = { at: number; value: Herd }
const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<Herd>>()

// Who a token belongs to changes rarely; remember it for the life of this instance.
const viewers = new Map<string, { login: string; at: number }>()

async function viewerLogin(token: string) {
  const cached = viewers.get(token)
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.login
  const viewer = await fetchViewer(token)
  viewers.set(token, { login: viewer.login, at: Date.now() })
  return viewer.login
}

function load(key: string, token: string, scope: Scope, days: number, openMode: OpenMode): Promise<Herd> {
  const running = inflight.get(key)
  if (running) return running
  const promise = fetchHerd(token, { scope, days, openMode })
    .then((value) => {
      cache.set(key, { at: Date.now(), value })
      // A quarter of a busy organization is a few megabytes; keep the cache small.
      if (cache.size > 40) cache.delete(cache.keys().next().value!)
      return value
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, promise)
  return promise
}

export async function GET(req: Request) {
  const token = await resolveToken(req)
  if (!token) return NextResponse.json({ error: "Not signed in" }, { status: 401 })
  const url = new URL(req.url)
  const raw = url.searchParams.get("scope") ?? "me"
  const days = Math.max(1, Math.min(366, Math.floor(Number(url.searchParams.get("days")) || 1)))
  const openMode: OpenMode = url.searchParams.get("open") === "all" ? "all" : "active"
  const fresh = url.searchParams.get("fresh") === "1"
  try {
    const scope: Scope = raw === "me" ? { kind: "me", login: await viewerLogin(token) } : { kind: "org", login: raw }
    if (scope.kind === "org" && !SCOPE.test(scope.login)) return NextResponse.json({ error: "That is not a GitHub organization name" }, { status: 400 })
    const key = `${createHash("sha256").update(token).digest("hex").slice(0, 16)}|${scope.kind}:${scope.login}|${days}|${openMode}`
    const cached = cache.get(key)
    const age = cached ? Date.now() - cached.at : Infinity
    if (cached && age < KEEP_MS && !(fresh && age > 5_000)) {
      if (age > STALE_MS) after(() => load(key, token, scope, days, openMode).catch(() => undefined))
      return NextResponse.json(cached.value, { headers: { "cache-control": "private, no-store", "x-pasture-age": String(Math.round(age / 1000)) } })
    }
    const herd = await load(key, token, scope, days, openMode)
    return NextResponse.json(herd, { headers: { "cache-control": "private, no-store", "x-pasture-age": "0" } })
  } catch (error) {
    const status = error instanceof GitHubError ? error.status : 502
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status })
  }
}
