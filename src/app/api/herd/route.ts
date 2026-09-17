import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NextResponse, after } from "next/server"
import { fetchHerd, fetchViewer, GitHubError } from "@/lib/github"
import type { Herd, OpenMode, Scope } from "@/lib/pasture/types"
import { blockedUntil, lowOnBudget } from "@/lib/rate-gate"
import { resolveToken, tokenMode } from "@/lib/token"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
// A GitHub search over a busy organization takes several seconds; the platform default of ten is too tight.
export const maxDuration = 60

const SCOPE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

/**
 * GitHub takes several seconds to answer a search over a busy organization,
 * so the last answer is kept per person and field. A read younger than
 * `STALE_MS` is served as is. An older one is served straight away and
 * topped up after the response has gone out, so the field paints at once and
 * catches up quietly; a poll that asks for `fresh` waits for the top-up. The
 * last good herd is never thrown away for being old: when GitHub cannot be
 * asked (the account's hourly budget is spent, GitHub is down) it is served
 * marked stale, so a field that was full never empties.
 */
const STALE_MS = 45_000
/** A `fresh` poll younger than this is answered from memory; two tabs on one field share a read. */
const FRESH_MS = 5_000
/** Herds remembered per instance; a quarter of a busy organization is a few megabytes each. */
const MAX_ENTRIES = 40

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

/**
 * A TV's server restarts (a rebuild, a reboot) and would come up with nothing
 * to show until GitHub answers, which in a spent hour is a long time. In
 * single-token mode (one shared view, the kiosk installer's mode) the last
 * herd is also kept on disk. Never in sign-in mode: there every herd is one
 * person's, and Vercel's disk is not theirs.
 */
const DISK = tokenMode() ? process.env.PASTURE_CACHE_DIR || join(tmpdir(), "pasture-herds") : undefined

async function readDisk(key: string): Promise<Entry | undefined> {
  if (!DISK) return undefined
  try {
    const entry = JSON.parse(await readFile(join(DISK, `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`), "utf8")) as Entry
    return entry && typeof entry.at === "number" && entry.value && Array.isArray(entry.value.open) ? entry : undefined
  } catch {
    return undefined
  }
}

function writeDisk(key: string, entry: Entry) {
  if (!DISK) return
  const path = join(DISK, `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`)
  mkdir(DISK, { recursive: true })
    .then(() => writeFile(path, JSON.stringify(entry)))
    .catch(() => undefined)
}

function remember(key: string, value: Herd) {
  const entry = { at: Date.now(), value }
  cache.delete(key)
  cache.set(key, entry)
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!)
  writeDisk(key, entry)
}

function load(key: string, token: string, scope: Scope, days: number, openMode: OpenMode, previous?: Herd): Promise<Herd> {
  const running = inflight.get(key)
  if (running) return running
  const promise = fetchHerd(token, { scope, days, openMode }, Date.now(), previous)
    .then((value) => {
      remember(key, value)
      return value
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, promise)
  return promise
}

/** The remembered herd, marked with why it is not fresher. */
function stale(entry: Entry, error: unknown): Herd {
  const reason = error instanceof Error ? error.message : String(error)
  const resetAt = error instanceof GitHubError ? error.resetAt : undefined
  return { ...entry.value, stale: { reason, resetAt } }
}

const headers = (age: number, stale = false) => ({ "cache-control": "private, no-store", "x-pasture-age": String(Math.round(age / 1000)), ...(stale ? { "x-pasture-stale": "1" } : {}) })

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
    let cached = cache.get(key)
    if (!cached) {
      cached = await readDisk(key)
      if (cached) cache.set(key, cached)
    }
    const now = Date.now()
    const age = cached ? now - cached.at : Infinity
    if (cached && (age < STALE_MS || (fresh && age < FRESH_MS))) return NextResponse.json(cached.value, { headers: headers(age) })
    if (cached) {
      // GitHub has refused this account for the hour, or nearly has: keep the herd we have until it refills.
      if (blockedUntil(token) || lowOnBudget(token)) {
        const until = blockedUntil(token)
        return NextResponse.json(stale(cached, new GitHubError("GitHub's hourly limit for this account is spent; showing the last herd until it resets.", 429, until || undefined)), { headers: headers(age, true) })
      }
      if (!fresh) {
        after(() => load(key, token, scope, days, openMode, cached!.value).catch(() => undefined))
        return NextResponse.json(cached.value, { headers: headers(age) })
      }
      try {
        return NextResponse.json(await load(key, token, scope, days, openMode, cached.value), { headers: headers(0) })
      } catch (error) {
        return NextResponse.json(stale(cached, error), { headers: headers(age, true) })
      }
    }
    const herd = await load(key, token, scope, days, openMode)
    return NextResponse.json(herd, { headers: headers(0) })
  } catch (error) {
    const status = error instanceof GitHubError ? error.status : 502
    const resetAt = error instanceof GitHubError ? error.resetAt : undefined
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error), resetAt }, { status })
  }
}
