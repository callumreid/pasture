import { describe, expect, test } from "vitest"
import type { ClosedPullRequest, Herd, MergedPullRequest, OpenPullRequest } from "@/lib/pasture/types"
import { FULL_READ_MS, canTopUp, topUp } from "./herd-refresh"

const T = Date.UTC(2026, 8, 17, 16, 0, 0)
const HOUR = 3_600_000
const DAY = 24 * HOUR

const merged = (number: number, mergedAt: number, author = "ann", avatar: string | null = null): MergedPullRequest => ({
  repo: "acme/api",
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/api/pull/${number}`,
  createdAt: new Date(mergedAt - HOUR).toISOString(),
  mergedAt: new Date(mergedAt).toISOString(),
  author,
  authorAvatar: avatar,
  mergedBy: null,
  base: "main",
  labels: [],
})

const open = (number: number, author = "bob", avatar: string | null = "https://a/bob"): OpenPullRequest => ({
  repo: "acme/api",
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/api/pull/${number}`,
  isDraft: false,
  createdAt: new Date(T - HOUR).toISOString(),
  updatedAt: new Date(T).toISOString(),
  author,
  authorAvatar: avatar,
  review: "none",
  checks: "none",
  unresolvedCount: 0,
  state: "awaiting-review",
  inMergeQueue: false,
  behind: false,
  autoMerge: false,
  reRequested: false,
  reviewers: [],
  base: "main",
  head: "x",
  labels: [],
})

const closed = (number: number, closedAt: number): ClosedPullRequest => ({ repo: "acme/api", number, closedAt: new Date(closedAt).toISOString() })

function herd(overrides: Partial<Herd> = {}): Herd {
  return {
    scope: { kind: "org", login: "acme" },
    days: 90,
    openMode: "active",
    fetchedAt: T - 3 * 60_000,
    fullReadAt: T - HOUR,
    open: [open(10)],
    merged: [merged(3, T - DAY), merged(2, T - 10 * DAY), merged(1, T - 90 * DAY - HOUR)],
    closed: [closed(7, T - 2 * DAY)],
    people: [
      { login: "ann", avatarUrl: "https://a/ann" },
      { login: "bob", avatarUrl: "https://a/bob" },
    ],
    mergedTotal: 3,
    ...overrides,
  }
}

const request = { scope: { kind: "org" as const, login: "acme" }, days: 90, openMode: "active" as const }

describe("canTopUp", () => {
  test("only the same field, read in full recently enough", () => {
    expect(canTopUp(undefined, request, T)).toBe(false)
    expect(canTopUp(herd(), request, T)).toBe(true)
    expect(canTopUp(herd(), { ...request, days: 30 }, T)).toBe(false)
    expect(canTopUp(herd(), { ...request, openMode: "all" }, T)).toBe(false)
    expect(canTopUp(herd(), { ...request, scope: { kind: "org", login: "other" } }, T)).toBe(false)
    expect(canTopUp(herd({ fullReadAt: T - FULL_READ_MS - 1 }), request, T)).toBe(false)
    expect(canTopUp(herd({ fullReadAt: undefined, fetchedAt: T - FULL_READ_MS - 1 }), request, T)).toBe(false)
    expect(canTopUp(herd({ fetchedAt: T + 60_000 }), request, T)).toBe(false)
  })
})

describe("topUp", () => {
  test("new merges join the front, the fresh copy wins, and the window's trailing edge drops off", () => {
    const since = T - 90 * DAY
    const next = topUp(herd(), { open: [open(10)], merged: [merged(4, T - 60_000, "cat", "https://a/cat"), { ...merged(3, T - DAY), title: "PR 3 (renamed)" }], closed: [] }, T, since, 10_000)
    expect(next.merged.map((pr) => pr.number)).toEqual([4, 3, 2])
    expect(next.merged[1].title).toBe("PR 3 (renamed)")
    expect(next.fetchedAt).toBe(T)
    expect(next.fullReadAt).toBe(T - HOUR)
    expect(next.mergedTotal).toBe(3)
  })

  test("people are recounted, merged avatars come from memory and leave the cows", () => {
    const next = topUp(herd(), { open: [open(11, "dan", "https://a/dan")], merged: [merged(4, T - 60_000, "cat", "https://a/cat")], closed: [] }, T, T - 90 * DAY, 10_000)
    const people = Object.fromEntries(next.people.map((p) => [p.login, p.avatarUrl]))
    expect(people).toEqual({ dan: "https://a/dan", cat: "https://a/cat", ann: "https://a/ann" })
    expect(next.merged.every((pr) => pr.authorAvatar === null)).toBe(true)
    expect(next.open[0].authorAvatar).toBe("https://a/dan")
  })

  test("closed cows are merged the same way and GitHub's window count is kept when given", () => {
    const next = topUp(herd(), { open: [], merged: [], closed: [closed(8, T - 30_000), closed(7, T - 2 * DAY)], mergedTotal: 41 }, T, T - 90 * DAY, 10_000)
    expect(next.closed.map((pr) => pr.number)).toEqual([8, 7])
    expect(next.mergedTotal).toBe(41)
  })

  test("the budget still caps the herd and marks it truncated", () => {
    const next = topUp(herd(), { open: [], merged: [merged(5, T - 1000), merged(4, T - 2000)], closed: [] }, T, T - 90 * DAY, 3)
    expect(next.merged.map((pr) => pr.number)).toEqual([5, 4, 3])
    expect(next.truncatedMerged).toBe(true)
  })
})
