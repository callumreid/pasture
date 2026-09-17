/**
 * GitHub's GraphQL budget is five thousand points an hour per account, and
 * every kiosk, agent and command line signed in as that account draws on the
 * same pool. This remembers what GitHub last said about each token's budget,
 * and once GitHub refuses a request for lack of it, refuses locally until the
 * hour turns, so a starving field does not hammer GitHub (and fill the log)
 * for nothing. Nothing here stores a token beyond using it as a map key.
 */
export type Budget = { remaining?: number; resetAt?: number; blockedUntil: number }

const budgets = new Map<string, Budget>()
const MAX_TRACKED = 200

/** With no better information, stay off GitHub this long after it refuses a request. */
export const DEFAULT_BLOCK_MS = 2 * 60_000
/** Background refreshes stop when the budget falls below this, so lifting a cow or listing orgs still works. */
export const RESERVE = 200

export const RATE_LIMIT_MESSAGE = "GitHub's hourly limit for this account is spent; the field keeps its last herd and catches up when the hour resets."

function entry(token: string): Budget {
  let budget = budgets.get(token)
  if (!budget) {
    budget = { blockedUntil: 0 }
    budgets.set(token, budget)
    if (budgets.size > MAX_TRACKED) budgets.delete(budgets.keys().next().value!)
  }
  return budget
}

/** GitHub answered, and said how much budget is left and when it refills. */
export function noteBudget(token: string, remaining: number | undefined, resetAt: string | number | undefined, now = Date.now()) {
  const budget = entry(token)
  if (typeof remaining === "number" && Number.isFinite(remaining)) budget.remaining = remaining
  const reset = typeof resetAt === "string" ? Date.parse(resetAt) : resetAt
  if (typeof reset === "number" && Number.isFinite(reset)) budget.resetAt = reset
  // An answer means GitHub is talking to us again.
  if (budget.blockedUntil && budget.blockedUntil <= now) budget.blockedUntil = 0
  if (budget.remaining !== undefined && budget.remaining > 0) budget.blockedUntil = 0
}

/** GitHub refused a request for lack of budget: stay off it until the reset it last told us about, or a couple of minutes. */
export function noteRefusal(token: string, now = Date.now()): number {
  const budget = entry(token)
  budget.remaining = 0
  const reset = budget.resetAt && budget.resetAt > now ? budget.resetAt : now + DEFAULT_BLOCK_MS
  // A refusal after the reset we knew about means that reset was stale; wait a fresh interval.
  budget.blockedUntil = Math.max(reset, now + 15_000)
  return budget.blockedUntil
}

/** When this token may talk to GitHub again, or 0 when it may right now. */
export function blockedUntil(token: string, now = Date.now()): number {
  const budget = budgets.get(token)
  if (!budget || budget.blockedUntil <= now) return 0
  return budget.blockedUntil
}

/** Little budget left before the reset: leave it for the things a person is waiting on. */
export function lowOnBudget(token: string, now = Date.now()): boolean {
  const budget = budgets.get(token)
  if (!budget || budget.remaining === undefined) return false
  if (budget.resetAt !== undefined && budget.resetAt <= now) return false
  return budget.remaining < RESERVE
}

export function budgetOf(token: string): Budget | undefined {
  return budgets.get(token)
}

/**
 * GitHub spells its rate-limit refusal several ways: GraphQL `RATE_LIMITED`,
 * the newer `RATE_LIMIT` with code `graphql_rate_limit`, and an HTTP 403 whose
 * body mentions the limit. All of them mean "come back next hour".
 */
export function isRateLimitError(error: { type?: string | null; code?: string | null; message?: string | null } | undefined | null): boolean {
  if (!error) return false
  if (error.type === "RATE_LIMITED" || error.type === "RATE_LIMIT") return true
  if (error.code && /rate_limit/i.test(error.code)) return true
  return !!error.message && /rate limit/i.test(error.message)
}

/** Tests only. */
export function resetBudgets() {
  budgets.clear()
}
