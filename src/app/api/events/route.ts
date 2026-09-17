import { NextResponse } from "next/server"
import { activeEvents, parseICS, parseManualEvents, upcomingEvents, type PartyEvent } from "@/lib/events"
import { resolveToken } from "@/lib/token"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 30

const CACHE_MS = 10 * 60_000
let cache: { at: number; value: Promise<PartyEvent[]> } | undefined

const feedUrls = () => (process.env.PASTURE_EVENTS_ICS || "").split(/[\s,]+/).filter((url) => /^https?:\/\//.test(url))

export const eventsConfigured = () => feedUrls().length > 0 || !!process.env.PASTURE_EVENTS?.trim()

async function readFeed(url: string): Promise<PartyEvent[]> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000), headers: { accept: "text/calendar, text/plain;q=0.8, */*;q=0.5" } })
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return parseICS(await response.text())
}

/** Every event from every feed, plus the hand-written ones; a feed that fails just contributes nothing this time. */
function loadEvents(now: number): Promise<PartyEvent[]> {
  if (cache && now - cache.at < CACHE_MS) return cache.value
  const value = (async () => {
    const feeds = await Promise.allSettled(feedUrls().map(readFeed))
    const fromFeeds = feeds.flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    if (feeds.length && feeds.every((result) => result.status === "rejected")) {
      cache = undefined
      throw (feeds[0] as PromiseRejectedResult).reason
    }
    return [...fromFeeds, ...parseManualEvents(process.env.PASTURE_EVENTS)].sort((a, b) => a.start.localeCompare(b.start))
  })()
  cache = { at: now, value }
  return value
}

/**
 * Is there a party on? The home organization's events (`PASTURE_EVENTS_ICS`,
 * `PASTURE_EVENTS`) open the barn doors on the home field only.
 */
export async function GET(req: Request) {
  const token = await resolveToken(req)
  if (!token) return NextResponse.json({ error: "Not signed in" }, { status: 401 })
  const now = Date.now()
  const home = (process.env.PASTURE_DEFAULT_ORG || "").toLowerCase()
  const scope = (new URL(req.url).searchParams.get("scope") || "").toLowerCase()
  const quiet = { home: home || null, party: null, upcoming: [], checkedAt: now }
  const headers = { "cache-control": "private, no-store" }
  if (!eventsConfigured() || !home || scope !== home) return NextResponse.json(quiet, { headers })
  try {
    const events = await loadEvents(now)
    return NextResponse.json({ home, party: activeEvents(events, now)[0] ?? null, upcoming: upcomingEvents(events, now, 3), checkedAt: now }, { headers })
  } catch (error) {
    return NextResponse.json({ ...quiet, error: error instanceof Error ? error.message : String(error) }, { headers })
  }
}
