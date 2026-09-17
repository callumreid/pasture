import { describe, expect, test } from "vitest"
import { LIMBO_MS, advanceLimbo, buildMembers, openDetail, penCounts, personCounts } from "./members"
import type { MergedPullRequest, OpenPullRequest } from "./types"

function open(number: number, state: OpenPullRequest["state"] = "awaiting-review", author = "callumreid"): OpenPullRequest {
  return {
    repo: "coval-ai/backend",
    number,
    title: `PR ${number}`,
    url: `https://github.com/coval-ai/backend/pull/${number}`,
    isDraft: state === "draft",
    createdAt: "2026-09-10T10:00:00Z",
    updatedAt: "2026-09-10T11:00:00Z",
    author,
    authorAvatar: null,
    review: state === "ready" ? "approved" : state === "changes-requested" ? "changes-requested" : "review-required",
    checks: state === "checks-failing" ? "failure" : "success",
    unresolvedCount: state === "unresolved" ? 2 : 0,
    state,
    inMergeQueue: state === "merge-queue",
    behind: false,
    autoMerge: false,
    reRequested: false,
    reviewers: [],
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    base: "main",
    head: "feat/x",
    labels: [],
  }
}

function merged(number: number, author = "callumreid"): MergedPullRequest {
  return {
    repo: "coval-ai/backend",
    number,
    title: `PR ${number}`,
    url: `https://github.com/coval-ai/backend/pull/${number}`,
    createdAt: "2026-09-10T09:00:00Z",
    mergedAt: "2026-09-10T12:00:00Z",
    author,
    authorAvatar: null,
    mergedBy: null,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    base: "main",
    labels: [],
  }
}

describe("pasture members", () => {
  test("open PRs land in their stage pen and merged ones out back", () => {
    const members = buildMembers([open(1, "draft"), open(2, "ready"), open(3, "changes-requested"), open(4)], [merged(9)], new Map(), 150)
    expect(members.map((m) => [m.id, m.pen])).toEqual([
      ["coval-ai/backend#9", "merged"],
      ["coval-ai/backend#1", "draft"],
      ["coval-ai/backend#2", "ready"],
      ["coval-ai/backend#3", "changes"],
      ["coval-ai/backend#4", "awaiting"],
    ])
    expect(penCounts(members)).toEqual({ draft: 1, awaiting: 1, changes: 1, ready: 1, merged: 1, recent: 0 })
  })

  test("a PR listed both open and merged is one cow, in the merged pen, with the same coat", () => {
    const members = buildMembers([open(5)], [merged(5)], new Map(), 150)
    expect(members).toHaveLength(1)
    expect(members[0].pen).toBe("merged")
    const asOpen = buildMembers([open(5)], [], new Map(), 150)[0]
    expect(asOpen.breed.id).toBe(members[0].breed.id)
    expect(asOpen.seed).toBe(members[0].seed)
  })

  test("the cap keeps every open cow and trims the oldest merges", () => {
    const merges = Array.from({ length: 10 }, (_, i) => merged(100 + i))
    const members = buildMembers([open(1), open(2)], merges, new Map(), 5)
    expect(members).toHaveLength(5)
    expect(members.filter((m) => m.kind === "open")).toHaveLength(2)
    expect(members.filter((m) => m.kind === "merged").map((m) => m.pr.number)).toEqual([100, 101, 102])
  })

  test("a release feed keeps waiting and recently released work in separate paddocks", () => {
    const members = buildMembers([open(1)], [merged(9)], new Map(), 150, [merged(10)], true)
    expect(members.map((member) => [member.id, member.pen, member.kind === "merged" ? member.release : undefined])).toEqual([
      ["coval-ai/backend#9", "merged", "waiting"],
      ["coval-ai/backend#10", "recent", "recent"],
      ["coval-ai/backend#1", "awaiting", undefined],
    ])
  })

  test("a vanished open PR is held until it shows up merged or times out", () => {
    const t0 = 1_000_000
    let limbo = advanceLimbo(new Map(), [open(7), open(8)], [open(8)], new Set(), t0)
    expect([...limbo.keys()]).toEqual(["coval-ai/backend#7"])
    const held = buildMembers([open(8)], [], limbo, 150)
    expect(held.find((m) => m.id === "coval-ai/backend#7")).toMatchObject({ kind: "open", held: true, pen: "awaiting" })
    limbo = advanceLimbo(limbo, [open(8)], [open(8)], new Set(["coval-ai/backend#7"]), t0 + 60_000)
    expect(limbo.size).toBe(0)
    limbo = advanceLimbo(new Map(), [open(7)], [], new Set(), t0)
    limbo = advanceLimbo(limbo, [], [], new Set(), t0 + LIMBO_MS + 1)
    expect(limbo.size).toBe(0)
  })

  test("a PR that shows up closed is never held for the merged search", () => {
    const t0 = 1_000_000
    const limbo = advanceLimbo(new Map(), [open(7), open(8)], [open(8)], new Set(), t0, new Set(["coval-ai/backend#7"]))
    expect(limbo.size).toBe(0)
    const held = advanceLimbo(new Map(), [open(7)], [], new Set(), t0)
    expect(advanceLimbo(held, [], [], new Set(), t0 + 1000, new Set(["coval-ai/backend#7"])).size).toBe(0)
  })

  test("people are counted across open and merged cows, most first", () => {
    const members = buildMembers([open(1, "draft", "dana"), open(2, "ready", "jake")], [merged(9, "dana"), merged(10, "dana")], new Map(), 150)
    expect([...personCounts(members)]).toEqual([
      ["dana", 3],
      ["jake", 1],
    ])
  })

  test("the detail line explains what is holding a PR up", () => {
    expect(openDetail(open(1, "draft"))).toBe("Draft")
    expect(openDetail(open(2, "ready"))).toBe("Ready to merge · approved · CI green")
    expect(openDetail(open(3, "checks-failing"))).toBe("Checks not green · CI failing")
    expect(openDetail({ ...open(4, "unresolved"), autoMerge: true })).toBe("Unresolved comments · CI green · 2 unresolved · auto-merge armed")
  })
})
