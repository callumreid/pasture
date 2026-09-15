import { describe, expect, test } from "vitest"
import { PENS, RELEASE_PENS, insidePen, penCenter, penForState } from "./pens"

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

  test("release mode splits the original rear pasture into equal non-overlapping paddocks", () => {
    const [waiting, recent] = RELEASE_PENS
    expect(waiting.rect.x1 - waiting.rect.x0).toBeCloseTo(recent.rect.x1 - recent.rect.x0)
    expect(waiting.rect.z0).toBe(recent.rect.z0)
    expect(waiting.rect.z1).toBe(recent.rect.z1)
    for (const pen of RELEASE_PENS) {
      const centre = penCenter(pen.id, true)
      expect(insidePen(pen.id, centre.x, centre.z, 1, true)).toBe(true)
    }
  })
})
