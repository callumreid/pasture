/**
 * GitHub's search answers at most 1000 results per query, in pages of up to
 * 100, and it pages sequentially. A busy organization merges thousands of
 * pull requests a quarter, so a window is cut into date slices small enough
 * to read in full: ask GitHub how many match the whole window, halve any
 * slice with too many, ask again, and then read the slices in parallel.
 * Newest slices come first, so a budget keeps the newest results.
 */

/** Results one search can page through, however many match. */
export const SEARCH_LIMIT = 1000

export type Slice = { from: number; to: number; count: number }

export type PlanOptions = {
  /** Results a slice may hold before it is split; a few pages' worth. */
  target: number
  /** Never split a slice narrower than this many milliseconds. */
  minWidth: number
  /** Concurrent calls to GitHub. */
  parallel: number
}

export type ReadOptions = PlanOptions & {
  /** Newest results kept; slices past this are not read. */
  budget: number
  pageSize: number
}

export type Page<T> = { items: T[]; hasNextPage: boolean; endCursor: string | null; remaining?: number }

export type WindowIO<T> = {
  /** How many results match the slice. */
  count(from: number, to: number): Promise<number>
  /** One page of the slice's results. */
  page(from: number, to: number, cursor: string | null): Promise<Page<T>>
}

export type WindowResult<T> = {
  items: T[]
  /** How many GitHub said match the whole window. */
  total: number
  /** Fewer were read than match: the budget ran out or a slice could not be split small enough. */
  truncated: boolean
  remaining?: number
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
export async function mapLimit<A, B>(items: A[], limit: number, fn: (item: A, index: number) => Promise<B>): Promise<B[]> {
  const out: B[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * Split `[from, to]` into slices that each hold at most `target` results,
 * as far as `minWidth` allows. Slices meet at whole seconds (GitHub's
 * qualifiers are second-precise) with no overlap. Newest first.
 */
export async function planSlices(count: WindowIO<unknown>["count"], from: number, to: number, opts: PlanOptions): Promise<{ slices: Slice[]; total: number }> {
  const total = await count(from, to)
  const leaves: Slice[] = []
  let open: Slice[] = [{ from, to, count: total }]
  while (open.length) {
    const split: Slice[] = []
    for (const slice of open) {
      if (slice.count <= opts.target || slice.to - slice.from <= opts.minWidth) leaves.push(slice)
      else split.push(slice)
    }
    if (!split.length) break
    const halves = split.flatMap((slice) => {
      const mid = slice.from + Math.floor((slice.to - slice.from) / 2000) * 1000
      return [
        { from: slice.from, to: mid },
        { from: mid + 1000, to: slice.to },
      ]
    })
    const counts = await mapLimit(halves, opts.parallel, (half) => count(half.from, half.to))
    open = halves.map((half, i) => ({ ...half, count: counts[i] }))
  }
  leaves.sort((a, b) => b.to - a.to)
  return { slices: leaves, total }
}

/** Plan the window, then read the newest slices in parallel until the budget is spent. */
export async function readWindow<T>(io: WindowIO<T>, from: number, to: number, opts: ReadOptions): Promise<WindowResult<T>> {
  const { slices, total } = await planSlices(io.count, from, to, opts)
  const chosen: Slice[] = []
  let planned = 0
  for (const slice of slices) {
    if (planned >= opts.budget) break
    chosen.push(slice)
    planned += slice.count
  }
  let truncated = chosen.length < slices.length
  let remaining: number | undefined
  const maxPages = Math.max(1, Math.ceil(SEARCH_LIMIT / opts.pageSize))
  const pages = await mapLimit(chosen, opts.parallel, async (slice) => {
    const items: T[] = []
    let cursor: string | null = null
    for (let page = 0; page < maxPages; page++) {
      const result: Page<T> = await io.page(slice.from, slice.to, cursor)
      items.push(...result.items)
      if (result.remaining !== undefined) remaining = remaining === undefined ? result.remaining : Math.min(remaining, result.remaining)
      if (!result.hasNextPage || !result.endCursor) return items
      cursor = result.endCursor
    }
    truncated = true
    return items
  })
  return { items: pages.flat(), total, truncated, remaining }
}
