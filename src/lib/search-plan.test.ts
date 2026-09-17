import { describe, expect, test } from "vitest"
import { mapLimit, planSlices, readWindow, type WindowIO } from "./search-plan"

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** A fake index: one result per `at` timestamp; counts and pages answer from it. */
function fakeIndex(times: number[], pageSize: number) {
  const calls = { counts: 0, pages: 0, concurrent: 0, peak: 0 }
  const io: WindowIO<number> = {
    async count(from, to) {
      calls.counts++
      return times.filter((t) => t >= from && t <= to).length
    },
    async page(from, to, cursor) {
      calls.pages++
      calls.concurrent++
      calls.peak = Math.max(calls.peak, calls.concurrent)
      await new Promise((resolve) => setTimeout(resolve, 1))
      calls.concurrent--
      const hits = times.filter((t) => t >= from && t <= to).sort((a, b) => b - a)
      const start = cursor ? Number(cursor) : 0
      const items = hits.slice(start, start + pageSize)
      const end = start + items.length
      return { items, hasNextPage: end < hits.length, endCursor: end < hits.length ? String(end) : null, remaining: 4000 - calls.pages }
    },
  }
  return { io, calls }
}

describe("search planning", () => {
  test("a window with few results is one slice", async () => {
    const { io, calls } = fakeIndex([10 * DAY, 20 * DAY, 30 * DAY], 100)
    const { slices, total } = await planSlices(io.count, 0, 90 * DAY, { target: 300, minWidth: HOUR, parallel: 4 })
    expect(total).toBe(3)
    expect(slices).toEqual([{ from: 0, to: 90 * DAY, count: 3 }])
    expect(calls.counts).toBe(1)
  })

  test("busy slices are halved until each fits the target, newest first, without overlap", async () => {
    // 2000 merges bunched into the last ten days of a ninety-day window.
    const times = Array.from({ length: 2000 }, (_, i) => 80 * DAY + Math.floor((i * 10 * DAY) / 2000))
    const { io } = fakeIndex(times, 100)
    const { slices, total } = await planSlices(io.count, 0, 90 * DAY, { target: 300, minWidth: HOUR, parallel: 4 })
    expect(total).toBe(2000)
    expect(slices.reduce((n, s) => n + s.count, 0)).toBe(2000)
    for (const slice of slices) expect(slice.count).toBeLessThanOrEqual(300)
    for (let i = 1; i < slices.length; i++) {
      expect(slices[i].to).toBeLessThan(slices[i - 1].from)
      expect(slices[i - 1].from - slices[i].to).toBe(1000)
    }
    expect(slices[0].to).toBe(90 * DAY)
    expect(slices[slices.length - 1].from).toBe(0)
  })

  test("a slice too narrow to split is kept even when it is over the target", async () => {
    const times = Array.from({ length: 500 }, () => 5 * DAY + 1234)
    const { io } = fakeIndex(times, 100)
    const { slices } = await planSlices(io.count, 0, 10 * DAY, { target: 100, minWidth: HOUR, parallel: 4 })
    const busy = slices.filter((s) => s.count > 0)
    expect(busy).toHaveLength(1)
    expect(busy[0].count).toBe(500)
    expect(busy[0].to - busy[0].from).toBeLessThanOrEqual(HOUR)
  })

  test("reading a window returns every result once and reports the total", async () => {
    const times = Array.from({ length: 1500 }, (_, i) => Math.floor((i * 90 * DAY) / 1500))
    const { io, calls } = fakeIndex(times, 100)
    const result = await readWindow(io, 0, 90 * DAY, { target: 300, minWidth: HOUR, parallel: 4, budget: 10_000, pageSize: 100 })
    expect(result.total).toBe(1500)
    expect(result.truncated).toBe(false)
    expect(new Set(result.items).size).toBe(1500)
    expect(result.items).toHaveLength(1500)
    expect(calls.peak).toBeLessThanOrEqual(4)
    expect(result.remaining).toBeDefined()
  })

  test("the budget keeps the newest slices and says the rest were left", async () => {
    const times = Array.from({ length: 1200 }, (_, i) => Math.floor((i * 60 * DAY) / 1200))
    const { io } = fakeIndex(times, 100)
    const result = await readWindow(io, 0, 60 * DAY, { target: 200, minWidth: HOUR, parallel: 4, budget: 500, pageSize: 100 })
    expect(result.truncated).toBe(true)
    expect(result.items.length).toBeGreaterThanOrEqual(500)
    expect(result.items.length).toBeLessThan(1200)
    const oldestRead = Math.min(...result.items)
    const unread = times.filter((t) => t < oldestRead)
    expect(unread.length).toBe(1200 - result.items.length)
  })

  test("a slice that cannot be paged in full is reported as truncated", async () => {
    const times = Array.from({ length: 1100 }, () => 5 * DAY)
    const { io } = fakeIndex(times, 100)
    const result = await readWindow(io, 0, 10 * DAY, { target: 300, minWidth: HOUR, parallel: 4, budget: 10_000, pageSize: 100 })
    expect(result.items).toHaveLength(1000)
    expect(result.truncated).toBe(true)
  })

  test("mapLimit keeps order and honours the limit", async () => {
    let running = 0
    let peak = 0
    const out = await mapLimit([5, 1, 3, 2, 4], 2, async (n) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, n))
      running--
      return n * 10
    })
    expect(out).toEqual([50, 10, 30, 20, 40])
    expect(peak).toBe(2)
  })
})
