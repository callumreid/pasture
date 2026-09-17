import { NextResponse } from "next/server"
import { fetchPullRequestStats, GitHubError } from "@/lib/github"
import { resolveToken } from "@/lib/token"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/

/** One pull request's diff (additions, deletions, files), for a lifted merged cow. */
export async function GET(req: Request) {
  const token = await resolveToken(req)
  if (!token) return NextResponse.json({ error: "Not signed in" }, { status: 401 })
  const url = new URL(req.url)
  const repo = url.searchParams.get("repo") ?? ""
  const number = Number(url.searchParams.get("number"))
  if (!REPO.test(repo) || !Number.isInteger(number) || number <= 0) return NextResponse.json({ error: "That is not a pull request" }, { status: 400 })
  try {
    const stats = await fetchPullRequestStats(token, repo, number)
    if (!stats) return NextResponse.json({ error: "No such pull request" }, { status: 404 })
    return NextResponse.json(stats, { headers: { "cache-control": "private, max-age=300" } })
  } catch (error) {
    const status = error instanceof GitHubError ? error.status : 502
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status })
  }
}
