import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { NextResponse, after } from "next/server"
import { fetchHerd, fetchViewer, GitHubError } from "@/lib/github"
import type { Herd, HerdRequest, OpenMode, Scope } from "@/lib/pasture/types"
import { narrowHerd } from "@/lib/herd-fallback"
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

type Entry = { at: number; value: Herd; derived?: boolean }
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
const DISK = tokenMode() ? process.env.PASTURE_CACHE_DIR || join(homedir(), ".cache", "pasture", "herds") : undefined
// Read the old temporary location during migration, but write durable snapshots.
const READ_DISKS = DISK ? [...new Set([DISK, ...(!process.env.PASTURE_CACHE_DIR ? [join(tmpdir(), "pasture-herds")] : [])])] : []
const filename = (key: string) => `${key.replace(/[^A-Za-z0-9._-]/g, "_")}.json`

async function readEntry(path: string): Promise<Entry | undefined> {
  try {
    const entry = JSON.parse(await readFile(path, "utf8")) as Entry
    const value = entry?.value
    return Number.isFinite(entry?.at) && value?.scope && Number.isFinite(value.fetchedAt) &&
      [value.open, value.merged, value.closed, value.people].every(Array.isArray) ? entry : undefined
  } catch {
    return undefined
  }
}

async function readDisk(key: string): Promise<Entry | undefined> {
  for (const dir of READ_DISKS) {
    const entry = await readEntry(join(dir, filename(key)))
    if (entry) {
      if (dir !== DISK) await writeDisk(key, entry)
      return entry
    }
  }
}

async function writeDisk(key: string, entry: Entry) {
  if (!DISK) return
  const path = join(DISK, filename(key))
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await mkdir(DISK, { recursive: true, mode: 0o700 })
    await writeFile(temporary, JSON.stringify(entry), { mode: 0o600 })
    await rename(temporary, path)
  } catch {
    await unlink(temporary).catch(() => undefined)
  }
}

async function fallback(identity: string, input: HerdRequest): Promise<Entry | undefined> {
  let best: Entry | undefined
  const consider = (entry: Entry) => {
    if (best && best.value.fetchedAt >= entry.value.fetchedAt) return
    const value = narrowHerd(entry.value, input)
    if (value) best = { at: entry.at, value, derived: true }
  }
  // The token fingerprint AND scope must match: never reuse another person's herd.
  for (const [key, entry] of cache) if (key.startsWith(`${identity}|`)) consider(entry)
  const prefix = filename(`${identity}|`).slice(0, -5)
  for (const dir of READ_DISKS) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.startsWith(prefix)) continue
      const match = /^(\d+)_(all|active)\.json$/.exec(name.slice(prefix.length))
      if (!match || Number(match[1]) < input.days || (input.openMode === "all" && match[2] !== "all")) continue
      const entry = await readEntry(join(dir, name))
      if (entry) consider(entry)
    }
  }
  return best
}

function remember(key: string, value: Herd) {
  const entry = { at: Date.now(), value }
  cache.delete(key)
  cache.set(key, entry)
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!)
  return writeDisk(key, entry)
}

function load(key: string, token: string, scope: Scope, days: number, openMode: OpenMode, previous?: Herd): Promise<Herd> {
  const running = inflight.get(key)
  if (running) return running
  const promise = fetchHerd(token, { scope, days, openMode }, Date.now(), previous)
    .then(async (value) => {
      await remember(key, value)
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
    const identity = `${createHash("sha256").update(token).digest("hex").slice(0, 16)}|${scope.kind}:${scope.login}`
    const key = `${identity}|${days}|${openMode}`
    let cached = cache.get(key)
    if (!cached) {
      cached = await readDisk(key)
      if (cached) cache.set(key, cached)
    }
    if (!cached) {
      cached = await fallback(identity, { scope, days, openMode })
      if (cached) {
        cache.set(key, cached)
        if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!)
        await writeDisk(key, cached)
      }
    }
    const now = Date.now()
    const age = cached ? now - cached.at : Infinity
    if (cached && !cached.derived && (age < STALE_MS || (fresh && age < FRESH_MS))) return NextResponse.json(cached.value, { headers: headers(age) })
    if (cached) {
      // GitHub has refused this account for the hour, or nearly has: keep the herd we have until it refills.
      if (blockedUntil(token) || lowOnBudget(token)) {
        const until = blockedUntil(token)
        return NextResponse.json(stale(cached, new GitHubError("GitHub's hourly limit for this account is spent; showing the last herd until it resets.", 429, until || undefined)), { headers: headers(age, true) })
      }
      if (!fresh) {
        after(() => load(key, token, scope, days, openMode, cached!.derived ? undefined : cached!.value).catch(() => undefined))
        return NextResponse.json(cached.value, { headers: headers(age, cached.derived) })
      }
      try {
        return NextResponse.json(await load(key, token, scope, days, openMode, cached.derived ? undefined : cached.value), { headers: headers(0) })
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
