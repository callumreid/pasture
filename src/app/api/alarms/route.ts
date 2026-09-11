import { NextResponse } from "next/server"
import { AlarmError, alarmsConfigured, fetchAlarms } from "@/lib/alarms"
import type { Alarms } from "@/lib/pasture/types"
import { resolveToken } from "@/lib/token"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

/**
 * The alarm list is the same for everyone on the field, so one read a minute
 * serves every open tab. It is gated on the GitHub sign-in all the same:
 * incident titles are not for anonymous visitors.
 */
const KEEP_MS = 60_000

let cached: { at: number; value: Alarms } | undefined
let inflight: Promise<Alarms> | undefined

function load(): Promise<Alarms> {
  if (inflight) return inflight
  inflight = fetchAlarms()
    .then((alarms) => ({ configured: true, alarms, fetchedAt: Date.now() }))
    .catch((error: unknown) => ({
      configured: true,
      // Keep the last good pack through a hiccup rather than sending the wolves home.
      alarms: cached?.value.alarms ?? [],
      fetchedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    }))
    .then((value) => {
      cached = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      inflight = undefined
    })
  return inflight
}

export async function GET(req: Request) {
  const token = await resolveToken(req)
  if (!token) return NextResponse.json({ error: "Not signed in" }, { status: 401 })
  if (!alarmsConfigured()) {
    const empty: Alarms = { configured: false, alarms: [], fetchedAt: Date.now() }
    return NextResponse.json(empty, { headers: { "cache-control": "private, no-store" } })
  }
  try {
    const value = cached && Date.now() - cached.at < KEEP_MS ? cached.value : await load()
    return NextResponse.json(value, { headers: { "cache-control": "private, no-store" } })
  } catch (error) {
    const status = error instanceof AlarmError ? error.status : 502
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status })
  }
}
