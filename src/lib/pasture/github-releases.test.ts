import { describe, expect, test } from "vitest"
import { buildGitHubReleaseFeed, isProductionEnvironment, releaseTargetLabel, type GitHubReleaseRepository } from "./github-releases"
import type { MergedPullRequest } from "./types"

const at = "2026-09-15T18:00:00Z"

function pr(number: number, mergeCommit: string): MergedPullRequest {
  return {
    repo: "acme/widgets",
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    createdAt: at,
    mergedAt: at,
    author: "octocat",
    authorAvatar: null,
    mergedBy: "mona",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    base: "main",
    labels: [],
    mergeCommit,
  }
}

describe("GitHub release observations", () => {
  test("discovers production names without mistaking previews or staging for production", () => {
    expect(isProductionEnvironment("Backend API Production")).toBe(true)
    expect(isProductionEnvironment("prod")).toBe(true)
    expect(isProductionEnvironment("Production – web-app")).toBe(true)
    expect(isProductionEnvironment("Preview – web-app")).toBe(false)
    expect(isProductionEnvironment("API Staging")).toBe(false)
    expect(releaseTargetLabel("acme/widgets", "Backend API Production")).toBe("Backend API")
    expect(releaseTargetLabel("acme/widgets", "Production")).toBe("widgets")
    expect(releaseTargetLabel("acme/widgets", "prod")).toBe("widgets")
  })

  test("derives waiting, recently released, and a live service event from deployment SHAs", () => {
    const repository: GitHubReleaseRepository = {
      nameWithOwner: "acme/widgets",
      defaultBranch: "main",
      headSha: "new",
      history: ["new", "middle", "prod", "old"],
      deployments: [
        {
          id: "live",
          environment: "API Production",
          commitOid: "new",
          state: "IN_PROGRESS",
          createdAt: "2026-09-15T18:50:00Z",
          updatedAt: "2026-09-15T18:51:00Z",
          latestStatus: { state: "IN_PROGRESS", createdAt: "2026-09-15T18:50:00Z", updatedAt: "2026-09-15T18:51:00Z", logUrl: "https://github.com/acme/widgets/actions/runs/1" },
        },
        {
          id: "current",
          environment: "API Production",
          commitOid: "prod",
          state: "ACTIVE",
          createdAt: "2026-09-15T18:00:00Z",
          updatedAt: "2026-09-15T18:10:00Z",
          latestStatus: { state: "SUCCESS", createdAt: "2026-09-15T18:10:00Z", updatedAt: "2026-09-15T18:10:00Z" },
        },
        {
          id: "previous",
          environment: "API Production",
          commitOid: "old",
          state: "INACTIVE",
          createdAt: "2026-09-14T18:00:00Z",
          updatedAt: "2026-09-15T18:10:00Z",
          latestStatus: { state: "INACTIVE", createdAt: "2026-09-15T18:10:00Z", updatedAt: "2026-09-15T18:10:00Z" },
        },
      ],
    }
    const feed = buildGitHubReleaseFeed([repository], [pr(1, "new"), pr(2, "middle"), pr(3, "prod")], Date.parse("2026-09-15T19:00:00Z"))

    expect(feed.waiting.map((item) => [item.number, item.targets])).toEqual([
      [1, ["API"]],
      [2, ["API"]],
    ])
    expect(feed.recent.map((item) => [item.number, item.targets, item.releasedAt])).toEqual([[3, ["API"], "2026-09-15T18:10:00Z"]])
    expect(feed.events[0]).toMatchObject({ id: "live", label: "API", phase: "deploying", pullRequests: ["acme/widgets#1", "acme/widgets#2"] })
  })

  test("keeps partially deployed work in waiting instead of showing it in both paddocks", () => {
    const repository: GitHubReleaseRepository = {
      nameWithOwner: "acme/widgets",
      defaultBranch: "main",
      headSha: "new",
      history: ["new", "api-prod", "old"],
      deployments: [
        { id: "api", environment: "API Production", commitOid: "new", state: "ACTIVE", createdAt: "2026-09-15T18:30:00Z", updatedAt: "2026-09-15T18:31:00Z", latestStatus: { state: "SUCCESS", createdAt: "2026-09-15T18:31:00Z", updatedAt: "2026-09-15T18:31:00Z" } },
        { id: "api-old", environment: "API Production", commitOid: "api-prod", state: "INACTIVE", createdAt: "2026-09-14T18:00:00Z", updatedAt: "2026-09-15T18:31:00Z" },
        { id: "worker", environment: "Worker Production", commitOid: "api-prod", state: "ACTIVE", createdAt: "2026-09-15T17:00:00Z", updatedAt: "2026-09-15T17:10:00Z", latestStatus: { state: "SUCCESS", createdAt: "2026-09-15T17:10:00Z", updatedAt: "2026-09-15T17:10:00Z" } },
        { id: "worker-old", environment: "Worker Production", commitOid: "old", state: "INACTIVE", createdAt: "2026-09-14T17:00:00Z", updatedAt: "2026-09-15T17:10:00Z" },
      ],
    }
    const feed = buildGitHubReleaseFeed([repository], [pr(1, "new"), pr(2, "api-prod")], Date.parse("2026-09-15T19:00:00Z"))
    expect(feed.waiting.map((item) => [item.number, item.targets])).toEqual([[1, ["Worker"]]])
    expect(feed.recent.map((item) => item.number)).toEqual([2])
  })
})
