import { beforeEach, describe, expect, test } from "vitest"
import { DEFAULT_BLOCK_MS, RESERVE, blockedUntil, isRateLimitError, lowOnBudget, noteBudget, noteRefusal, resetBudgets } from "./rate-gate"

const T = 1_700_000_000_000

describe("rate gate", () => {
  beforeEach(() => resetBudgets())

  test("a token nobody has heard from is free", () => {
    expect(blockedUntil("t", T)).toBe(0)
    expect(lowOnBudget("t", T)).toBe(false)
  })

  test("a refusal blocks until the reset GitHub last mentioned", () => {
    noteBudget("t", 12, new Date(T + 600_000).toISOString(), T)
    expect(blockedUntil("t", T)).toBe(0)
    expect(noteRefusal("t", T + 1000)).toBe(T + 600_000)
    expect(blockedUntil("t", T + 2000)).toBe(T + 600_000)
    expect(blockedUntil("t", T + 600_001)).toBe(0)
  })

  test("a refusal with no known reset waits a couple of minutes", () => {
    expect(noteRefusal("t", T)).toBe(T + DEFAULT_BLOCK_MS)
    expect(blockedUntil("t", T + DEFAULT_BLOCK_MS - 1)).toBe(T + DEFAULT_BLOCK_MS)
    expect(blockedUntil("t", T + DEFAULT_BLOCK_MS)).toBe(0)
  })

  test("a refusal after a stale reset does not unblock at once", () => {
    noteBudget("t", 0, T - 1000, T)
    const until = noteRefusal("t", T)
    expect(until).toBeGreaterThan(T + 10_000)
  })

  test("an answer with budget left lifts the block", () => {
    noteRefusal("t", T)
    noteBudget("t", 4800, T + 3_000_000, T + 5000)
    expect(blockedUntil("t", T + 6000)).toBe(0)
  })

  test("tokens are tracked separately", () => {
    noteRefusal("a", T)
    expect(blockedUntil("a", T + 1)).toBeGreaterThan(0)
    expect(blockedUntil("b", T + 1)).toBe(0)
  })

  test("low budget holds background reads until the reset", () => {
    noteBudget("t", RESERVE - 1, T + 60_000, T)
    expect(lowOnBudget("t", T)).toBe(true)
    expect(lowOnBudget("t", T + 60_000)).toBe(false)
    noteBudget("t", RESERVE, T + 120_000, T)
    expect(lowOnBudget("t", T)).toBe(false)
  })

  test("recognises every spelling of GitHub's refusal", () => {
    expect(isRateLimitError({ type: "RATE_LIMITED", message: "API rate limit exceeded for user ID 1." })).toBe(true)
    expect(isRateLimitError({ type: "RATE_LIMIT", code: "graphql_rate_limit", message: "API rate limit already exceeded for user ID 75899979." })).toBe(true)
    expect(isRateLimitError({ message: "API rate limit exceeded for 1.2.3.4." })).toBe(true)
    expect(isRateLimitError({ type: "NOT_FOUND", message: "Could not resolve to a Repository" })).toBe(false)
    expect(isRateLimitError({ message: "Resource limits for this query exceeded." })).toBe(false)
    expect(isRateLimitError(undefined)).toBe(false)
  })
})
