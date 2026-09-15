import { NextResponse } from "next/server"
import { fetchViewer } from "@/lib/github"
import { fetchReleaseSource, releaseScopes, releaseSourceConfigured } from "@/lib/release-feed-server"
import { resolveToken } from "@/lib/token"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 60

const SCOPE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
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
 * An optional release integration. It is only exposed on explicitly configured
 * organization fields, and only to a signed-in member of that organization.
 */
export async function GET(req: Request) {
  const token = await resolveToken(req)
  if (!token) return NextResponse.json({ error: "Not signed in" }, { status: 401 })
  const scope = (new URL(req.url).searchParams.get("scope") || "").toLowerCase()
  const quiet = { configured: false, scope, checkedAt: Date.now() }
  if (!SCOPE.test(scope) || !releaseSourceConfigured() || !releaseScopes().includes(scope)) {
    return NextResponse.json(quiet, { headers: { "cache-control": "private, no-store" } })
  }
  try {
    if (!(await viewerOrgs(token)).includes(scope)) return NextResponse.json(quiet, { headers: { "cache-control": "private, no-store" } })
    const feed = await fetchReleaseSource(token, scope)
    return NextResponse.json({ configured: true, scope, checkedAt: Date.now(), ...feed }, { headers: { "cache-control": "private, no-store" } })
  } catch {
    return NextResponse.json(
      { configured: true, scope, checkedAt: Date.now(), schemaVersion: 1, generatedAt: new Date().toISOString(), waiting: [], recent: [], events: [], error: "Release feed unavailable" },
      { status: 502, headers: { "cache-control": "private, no-store" } },
    )
  }
}
