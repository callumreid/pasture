import type { PrState } from "@/lib/pr-state"

/** Where a cow lives: one pen per stage of a pull request's life. */
export type PenID = "draft" | "awaiting" | "changes" | "ready" | "merged"

export type Rect = { x0: number; x1: number; z0: number; z1: number }

export type Pen = { id: PenID; name: string; rect: Rect }

/** The merged pen as built: as wide as the front row, and this deep before the herd needs more. */
export const MERGED_BASE: Rect = { x0: -46, x1: 46.2, z0: -34, z1: 3 }

/**
 * Four small pens across the front of the field, one wide pen behind them.
 * The camera looks in from the front (+z), so the lifecycle reads left to
 * right and then "up" into the merged herd. The merged pen's back fence
 * moves (see `mergedLayout`); everything reads its rect through `penFor`.
 */
export const PENS: Pen[] = [
  { id: "draft", name: "Drafts", rect: { x0: -46, x1: -24, z0: 6, z1: 28 } },
  { id: "awaiting", name: "Awaiting review", rect: { x0: -22.6, x1: -0.6, z0: 6, z1: 28 } },
  { id: "changes", name: "Changes requested", rect: { x0: 0.8, x1: 22.8, z0: 6, z1: 28 } },
  { id: "ready", name: "Ready to merge", rect: { x0: 24.2, x1: 46.2, z0: 6, z1: 28 } },
  { id: "merged", name: "Merged", rect: { ...MERGED_BASE } },
]

export const PEN_ORDER: PenID[] = ["draft", "awaiting", "changes", "ready", "merged"]

export function penFor(id: PenID): Pen {
  return PENS.find((pen) => pen.id === id) ?? PENS[PENS.length - 1]
}

/** The pen an open pull request grazes in, from its single stage. */
export function penForState(state: PrState): PenID {
  switch (state) {
    case "draft":
      return "draft"
    case "ready":
    case "merge-queue":
      return "ready"
    case "changes-requested":
    case "re-requested":
      return "changes"
    default:
      return "awaiting"
  }
}

export function penCenter(id: PenID) {
  const { rect } = penFor(id)
  return { x: (rect.x0 + rect.x1) / 2, z: (rect.z0 + rect.z1) / 2 }
}

export function insidePen(id: PenID, x: number, z: number, inset = 0) {
  const { rect } = penFor(id)
  return x >= rect.x0 + inset && x <= rect.x1 - inset && z >= rect.z0 + inset && z <= rect.z1 - inset
}

// ---------------------------------------------------------------- the herd out back

/** Room one full-size cow takes in the herd: across, and front to back. */
export const HERD_SPACING = { x: 2.5, z: 2.1 }
/** Clear of the fence. */
export const HERD_INSET = 1.6
/** The back fence goes no further than this from the front of the pen: the barn and the bay are behind it. */
export const MERGED_MAX_DEPTH = 150
/** Past the deepest pen, the cows shrink to fit, down to this. */
export const HERD_MIN_SCALE = 0.55
/** Slots the pond takes up in the base pen. */
const POND_SLOTS = 40
/** The fence moves in steps this big, so a handful of merges does not rebuild it. */
const DEPTH_STEP = 6
/** Likewise the cows shrink in steps, so a handful of merges does not re-seat the whole herd. */
const SCALE_STEP = 0.05

export type MergedLayout = { rect: Rect; scale: number; cols: number; rows: number }

const usableWidth = () => MERGED_BASE.x1 - MERGED_BASE.x0 - HERD_INSET * 2

function fit(count: number, scale: number) {
  const cols = Math.max(1, Math.floor(usableWidth() / (HERD_SPACING.x * scale)))
  const rows = Math.max(1, Math.ceil((count + POND_SLOTS) / cols))
  const depth = rows * HERD_SPACING.z * scale + HERD_INSET * 2
  return { cols, rows, depth }
}

/**
 * The merged pen that holds `count` cows: the pen as built until it is full,
 * then its back fence moves away from the camera, and once the fence has gone
 * as far as it can the cows shrink. A herd of thousands fades into the distance.
 */
export function mergedLayout(count: number): MergedLayout {
  const base = MERGED_BASE.z1 - MERGED_BASE.z0
  let scale = 1
  let { cols, rows, depth } = fit(count, 1)
  if (depth > MERGED_MAX_DEPTH) {
    const room = ((MERGED_MAX_DEPTH - HERD_INSET * 2) * usableWidth()) / (HERD_SPACING.x * HERD_SPACING.z)
    scale = Math.max(HERD_MIN_SCALE, Math.min(1, Math.floor(Math.sqrt(room / (count + POND_SLOTS)) / SCALE_STEP) * SCALE_STEP))
    ;({ cols, rows, depth } = fit(count, scale))
  }
  // The pen as built until it is full, then whole steps beyond it.
  depth = Math.min(MERGED_MAX_DEPTH, base + Math.ceil(Math.max(0, depth - base) / DEPTH_STEP) * DEPTH_STEP)
  return { rect: { ...MERGED_BASE, z0: MERGED_BASE.z1 - depth }, scale, cols, rows }
}

/** Move the merged pen's back fence; everything that reads the pen through `penFor` follows. */
export function setMergedRect(rect: Rect) {
  const pen = penFor("merged")
  pen.rect.x0 = rect.x0
  pen.rect.x1 = rect.x1
  pen.rect.z0 = rect.z0
  pen.rect.z1 = rect.z1
}

/**
 * Where each cow of the herd stands: rows from the front fence (the newest
 * merges, nearest the camera) to the back, a little jitter so it is a herd
 * and not a parade, and nobody in the pond. Always returns `count` spots; a
 * herd bigger than the pen wraps around and crowds up.
 */
export function herdSlots(layout: MergedLayout, count: number, rand: () => number, avoid: (x: number, z: number) => boolean): { x: number; z: number }[] {
  const { rect, scale, cols } = layout
  const sx = HERD_SPACING.x * scale
  const sz = HERD_SPACING.z * scale
  const x0 = rect.x0 + HERD_INSET + sx / 2
  const zFront = rect.z1 - HERD_INSET - sz / 2
  const rows = Math.max(1, Math.floor((rect.z1 - rect.z0 - HERD_INSET * 2) / sz))
  const slots: { x: number; z: number }[] = []
  for (let pass = 0; slots.length < count && pass < 8; pass++) {
    for (let row = 0; row < rows && slots.length < count; row++) {
      for (let col = 0; col < cols && slots.length < count; col++) {
        const x = x0 + col * sx + (rand() - 0.5) * sx * 0.55 + (row % 2 ? sx * 0.5 : 0)
        const z = zFront - row * sz + (rand() - 0.5) * sz * 0.45
        if (avoid(x, z)) continue
        slots.push({ x: Math.max(rect.x0 + HERD_INSET, Math.min(rect.x1 - HERD_INSET, x)), z })
      }
    }
  }
  return slots
}
