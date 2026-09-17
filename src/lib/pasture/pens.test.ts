import { describe, expect, test } from "vitest"
import { HERD_MIN_SCALE, MERGED_BASE, MERGED_MAX_DEPTH, PENS, herdSlots, insidePen, mergedLayout, penCenter, penFor, penForState, setMergedRect } from "./pens"

describe("pasture pens", () => {
  test("every stage lands in exactly one pen", () => {
    expect(penForState("draft")).toBe("draft")
    expect(penForState("ready")).toBe("ready")
    expect(penForState("merge-queue")).toBe("ready")
    expect(penForState("changes-requested")).toBe("changes")
    expect(penForState("re-requested")).toBe("changes")
    expect(penForState("awaiting-review")).toBe("awaiting")
    expect(penForState("unresolved")).toBe("awaiting")
    expect(penForState("checks-failing")).toBe("awaiting")
  })

  test("pens do not overlap and their centres sit inside them", () => {
    for (const pen of PENS) {
      const centre = penCenter(pen.id)
      expect(insidePen(pen.id, centre.x, centre.z, 1)).toBe(true)
      for (const other of PENS) {
        if (other === pen) continue
        expect(insidePen(other.id, centre.x, centre.z)).toBe(false)
      }
    }
  })
})

describe("the merged pen grows with the herd", () => {
  test("a small herd keeps the pen as built, at full size", () => {
    for (const count of [0, 1, 200, 500]) {
      const layout = mergedLayout(count)
      expect(layout.rect).toEqual(MERGED_BASE)
      expect(layout.scale).toBe(1)
    }
  })

  test("a bigger herd moves the back fence away from the camera, in steps", () => {
    const small = mergedLayout(500)
    const medium = mergedLayout(1500)
    const big = mergedLayout(3000)
    expect(medium.rect.z0).toBeLessThan(small.rect.z0)
    expect(big.rect.z0).toBeLessThan(medium.rect.z0)
    expect(medium.scale).toBe(1)
    expect((MERGED_BASE.z1 - medium.rect.z0 - (MERGED_BASE.z1 - MERGED_BASE.z0)) % 6).toBe(0)
    // A hundred merges move the fence at most once.
    const fences = new Set(Array.from({ length: 100 }, (_, i) => mergedLayout(1000 + i).rect.z0))
    expect(fences.size).toBeLessThanOrEqual(2)
    expect(medium.rect.x0).toBe(MERGED_BASE.x0)
    expect(medium.rect.x1).toBe(MERGED_BASE.x1)
  })

  test("past the deepest pen the cows shrink, but never below the floor", () => {
    const huge = mergedLayout(8000)
    expect(MERGED_BASE.z1 - huge.rect.z0).toBe(MERGED_MAX_DEPTH)
    expect(huge.scale).toBeLessThan(1)
    expect(huge.scale).toBeGreaterThanOrEqual(HERD_MIN_SCALE)
    expect(mergedLayout(50_000).scale).toBe(HERD_MIN_SCALE)
    expect(huge.cols * huge.rows).toBeGreaterThanOrEqual(8000)
    // A few hundred merges change the scale at most once, so the herd is not re-seated every refresh.
    const scales = new Set(Array.from({ length: 300 }, (_, i) => mergedLayout(7400 + i).scale))
    expect(scales.size).toBeLessThanOrEqual(2)
  })

  test("every cow gets a spot inside the pen, newest at the front, none in the pond", () => {
    const pond = (x: number, z: number) => Math.hypot((x + 30) / 8, (z + 19) / 6) < 1
    let seed = 1
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (const count of [10, 700, 8000]) {
      const layout = mergedLayout(count)
      const slots = herdSlots(layout, count, rand, pond)
      expect(slots).toHaveLength(count)
      for (const slot of slots) {
        expect(slot.x).toBeGreaterThanOrEqual(layout.rect.x0)
        expect(slot.x).toBeLessThanOrEqual(layout.rect.x1)
        expect(slot.z).toBeLessThanOrEqual(layout.rect.z1)
        expect(slot.z).toBeGreaterThanOrEqual(layout.rect.z0 - 0.01)
        expect(pond(slot.x, slot.z)).toBe(false)
      }
      expect(slots[0].z).toBeGreaterThan(slots[slots.length - 1].z)
    }
  })

  test("moving the fence is seen through penFor and insidePen", () => {
    const before = { ...penFor("merged").rect }
    try {
      setMergedRect({ ...before, z0: -100 })
      expect(insidePen("merged", 0, -80)).toBe(true)
      expect(mergedLayout(0).rect.z0).toBe(MERGED_BASE.z0)
    } finally {
      setMergedRect(before)
    }
    expect(insidePen("merged", 0, -80)).toBe(false)
  })
})
