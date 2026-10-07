import { NextResponse } from "next/server"
import { datadogConfigured, fetchAlerts } from "@/lib/datadog"
import { fetchViewer } from "@/lib/github"
import { resolveToken } from "@/lib/token"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 30

/** The most wolves the field will hold at once, however bad the day is. */
const WOLF_CAP = 8

// Who a token belongs to changes rarely; remember it for the life of this instance.
const viewers = new Map<string, { orgs: string[]; at: number }>()

async function viewerOrgs(token: string) {
  const cached = viewers.get(token)
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.orgs
  const viewer = await fetchViewer(token)
  const orgs = viewer.orgs.map((org) => org.login.toLowerCase())
  viewers.set(token, { orgs, at: Date.now() })
  return orgs
}

/**
 * Alerts firing in the deployment's Datadog, as wolves. The wolves belong to
 * the home organization (`PASTURE_DEFAULT_ORG`): they only show on that field,
 * and only to its members, so nobody else's alert names ever leave the server.
 */
export async function GET(req: Request) {
  const token = await resolveToken(req)
  if (!token) return NextResponse.json({ error: "Not signed in" }, { status: 401 })
  const home = (process.env.PASTURE_DEFAULT_ORG || "").toLowerCase()
  const scope = (new URL(req.url).searchParams.get("scope") || "").toLowerCase()
  const quiet = { home: home || null, count: 0, alerts: [], checkedAt: Date.now() }
  if (!datadogConfigured() || !home || scope !== home) return NextResponse.json(quiet, { headers: { "cache-control": "private, no-store" } })
  try {
    if (!(await viewerOrgs(token)).includes(home)) return NextResponse.json(quiet, { headers: { "cache-control": "private, no-store" } })
    const alerts = await fetchAlerts()
    return NextResponse.json(
      { home, count: alerts.length, alerts: alerts.slice(0, WOLF_CAP), checkedAt: Date.now() },
      { headers: { "cache-control": "private, no-store" } },
    )
  } catch (error) {
    return NextResponse.json({ ...quiet, error: error instanceof Error ? error.message : String(error) }, { status: 502 })
  }
}
