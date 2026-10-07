import { createHash } from "node:crypto"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import type { Herd } from "@/lib/pasture/types"

const state = vi.hoisted(() => ({ token: "alice", blocked: true, disk: true, fetchHerd: vi.fn(), after: vi.fn() }))
vi.mock("next/server", () => ({ NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) }, after: state.after }))
vi.mock("@/lib/token", () => ({ resolveToken: async () => state.token, tokenMode: () => state.disk }))
vi.mock("@/lib/rate-gate", () => ({ blockedUntil: () => state.blocked ? Date.now() + 60_000 : 0, lowOnBudget: () => false }))
vi.mock("@/lib/github", () => ({
  fetchHerd: state.fetchHerd,
  fetchViewer: async () => ({ login: state.token }),
  GitHubError: class extends Error { constructor(message: string, public status: number, public resetAt?: number) { super(message) } },
}))

const DAY = 86_400_000
const T = Date.UTC(2026, 9, 6, 10)
const iso = (n: number) => new Date(n).toISOString()
const snapshot = (overrides: Partial<Herd> = {}): Herd => ({
  scope: { kind: "org", login: "acme" }, days: 90, openMode: "all", fetchedAt: T, fullReadAt: T,
  open: [{ number: 1, author: "recent", updatedAt: iso(T - 1000) }, { number: 2, author: "old", updatedAt: iso(T - 10 * DAY) }],
  merged: [{ number: 3, author: "merged", mergedAt: iso(T - 1000) }, { number: 4, author: "older", mergedAt: iso(T - 5 * DAY) }],
  closed: [{ number: 5, closedAt: iso(T - 1000) }, { number: 6, closedAt: iso(T - 5 * DAY) }],
  people: ["recent", "old", "merged", "older"].map(login => ({ login, avatarUrl: null })), mergedTotal: 2,
  ...overrides,
} as Herd)
let dir: string
let priorDir: string | undefined
const key = (token: string, herd: Herd) => `${createHash("sha256").update(token).digest("hex").slice(0, 16)}_org_${herd.scope.login}_${herd.days}_${herd.openMode}.json`
async function save(herd = snapshot(), token = "alice") { await writeFile(join(dir, key(token, herd)), JSON.stringify({ at: herd.fetchedAt, value: herd })) }
const request = (query = "days=1&open=all&fresh=1") => new Request(`http://localhost/api/herd?scope=acme&${query}`)

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  dir = await mkdtemp(join(tmpdir(), "pasture-fallback-test-"))
  priorDir = process.env.PASTURE_CACHE_DIR
  process.env.PASTURE_CACHE_DIR = dir
  state.token = "alice"; state.blocked = true; state.disk = true
  state.fetchHerd.mockRejectedValue(new Error("GitHub unavailable"))
})
afterEach(async () => {
  if (priorDir === undefined) delete process.env.PASTURE_CACHE_DIR
  else process.env.PASTURE_CACHE_DIR = priorDir
  await rm(dir, { recursive: true, force: true })
})

test("cold 24-hour view survives rate limiting using a wider disk snapshot, including after restart", async () => {
  await save()
  let route = await import("./route")
  const response = await route.GET(request())
  expect(response.status).toBe(200)
  const herd = await response.json()
  expect(herd.days).toBe(1)
  expect(herd.merged.map((pr: { number: number }) => pr.number)).toEqual([3])
  expect(herd.closed.map((pr: { number: number }) => pr.number)).toEqual([5])
  expect(herd.open).toHaveLength(2)
  expect(herd.fetchedAt).toBe(T)
  expect(herd.stale).toBeTruthy()
  expect(response.headers.get("x-pasture-stale")).toBe("1")
  expect(state.fetchHerd).not.toHaveBeenCalled()
  vi.resetModules()
  route = await import("./route")
  expect((await (await route.GET(request())).json()).merged).toHaveLength(1)
})

test("Active filters open cows too and removes people outside the selected window", async () => {
  await save()
  const { GET } = await import("./route")
  const herd = await (await GET(request("days=1&open=active"))).json()
  expect(herd.open.map((pr: { number: number }) => pr.number)).toEqual([1])
  expect(herd.people.map((person: { login: string }) => person.login)).toEqual(["recent", "merged"])
})

test("does not cross token or scope boundaries or invent a wider/all-open snapshot", async () => {
  await save(snapshot(), "bob")
  await save(snapshot({ scope: { kind: "org", login: "other" } }))
  await save(snapshot({ days: 1, openMode: "active" }))
  const { GET } = await import("./route")
  expect((await GET(request("days=7&open=all"))).status).toBe(502)
  expect((await GET(request("days=1&open=all"))).status).toBe(502)
})

test("uses the newest compatible snapshot and does not carry the wider total", async () => {
  await save(snapshot({ fetchedAt: T - DAY }))
  await save(snapshot({ days: 7, truncatedMerged: true, mergedTotal: 100 }))
  const { GET } = await import("./route")
  const herd = await (await GET(request())).json()
  expect(herd.fetchedAt).toBe(T)
  expect(herd.truncatedMerged).toBe(true)
  expect(herd.mergedTotal).toBeUndefined()
})

test("a successful refresh replaces the derived snapshot and persists real fresh data", async () => {
  await save()
  const { GET } = await import("./route")
  await GET(request())
  state.blocked = false
  const fresh = snapshot({ days: 1, fetchedAt: Date.now(), merged: [] })
  state.fetchHerd.mockResolvedValue(fresh)
  const response = await GET(request())
  expect(await response.json()).toEqual(fresh)
  expect(state.fetchHerd.mock.calls[0][3]).toBeUndefined()
  const persisted = JSON.parse(await readFile(join(dir, key("alice", fresh)), "utf8"))
  expect(persisted.value.fetchedAt).toBe(fresh.fetchedAt)
  expect(persisted.derived).toBeUndefined()
})

test("sign-in mode can reuse its own memory without reading or writing any disk snapshots", async () => {
  state.disk = false; state.blocked = false
  state.fetchHerd.mockResolvedValue(snapshot())
  const { GET } = await import("./route")
  await GET(request("days=90&open=all"))
  state.blocked = true
  const response = await GET(request())
  expect(response.status).toBe(200)
  expect((await response.json()).merged).toHaveLength(1)
  expect(await readdir(dir)).toEqual([])
  state.token = "bob"
  state.fetchHerd.mockRejectedValue(new Error("blocked"))
  expect((await GET(request())).status).toBe(502)
})

test("a failed refresh or corrupt disk file still leaves the historical slice available", async () => {
  await save()
  await writeFile(join(dir, key("alice", snapshot({ days: 7 }))), "{broken")
  state.blocked = false
  const { GET } = await import("./route")
  const response = await GET(request())
  expect(response.status).toBe(200)
  const herd = await response.json()
  expect(herd.merged).toHaveLength(1)
  expect(herd.stale.reason).toBe("GitHub unavailable")
})
