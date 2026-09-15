import { describe, expect, test } from "vitest"
import { parseReleaseFeed, primaryReleaseEvent } from "./releases"

const pr = {
  repo: "acme/widgets",
  number: 42,
  title: "Make the widget shinier",
  url: "https://github.com/acme/widgets/pull/42",
  author: "octocat",
  mergedAt: "2026-09-15T17:00:00Z",
}

describe("release feeds", () => {
  test("normalizes the small provider contract into pasture pull requests", () => {
    const feed = parseReleaseFeed({
      schemaVersion: 1,
      generatedAt: "2026-09-15T18:00:00Z",
      window: { active: true, label: "Tuesday release" },
      waiting: [{ ...pr, targets: ["web"] }],
      recent: [{ ...pr, releasedAt: "2026-09-15T17:30:00Z" }, { ...pr, number: 43, title: "Ship it" }],
      events: [{ id: "deploy-1", label: "Web", environment: "production", phase: "verifying", pullRequests: ["acme/widgets#42"] }],
    })
    expect(feed.waiting[0]).toMatchObject({ base: "main", additions: 0, targets: ["web"] })
    expect(feed.recent.map((item) => item.number)).toEqual([43])
    expect(primaryReleaseEvent(feed)?.phase).toBe("verifying")
  })

  test("uses an active window as the calm before the release storm", () => {
    const feed = parseReleaseFeed({ schemaVersion: 1, generatedAt: "2026-09-15T18:00:00Z", window: { active: true }, waiting: [], recent: [], events: [] })
    expect(primaryReleaseEvent(feed)).toMatchObject({ id: "release-window", phase: "scheduled", environment: "production" })
  })

  test("prefers the most active service and lets terminal weather expire", () => {
    const feed = parseReleaseFeed({
      schemaVersion: 1,
      generatedAt: "2026-09-15T18:00:00Z",
      waiting: [],
      recent: [],
      events: [
        { id: "queued-api", label: "API", environment: "production", phase: "queued" },
        { id: "deploy-web", label: "Web", environment: "production", phase: "deploying" },
      ],
    })
    expect(primaryReleaseEvent(feed)).toMatchObject({ id: "deploy-web", label: "Web" })

    const succeeded = parseReleaseFeed({
      schemaVersion: 1,
      generatedAt: "2026-09-15T18:00:00Z",
      waiting: [],
      recent: [],
      events: [{ id: "done", label: "Web", environment: "production", phase: "succeeded", updatedAt: "2026-09-15T18:00:00Z" }],
    })
    expect(primaryReleaseEvent(succeeded, Date.parse("2026-09-15T18:04:59Z"))?.id).toBe("done")
    expect(primaryReleaseEvent(succeeded, Date.parse("2026-09-15T18:05:00Z"))).toBeUndefined()
  })

  test("rejects provider phases Pasture cannot render", () => {
    expect(() =>
      parseReleaseFeed({
        schemaVersion: 1,
        generatedAt: "2026-09-15T18:00:00Z",
        events: [{ id: "x", label: "Web", environment: "production", phase: "wobbling" }],
      }),
    ).toThrow("phase is not supported")
  })
})
