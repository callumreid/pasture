import { describe, expect, test } from "vitest"
import { hashString } from "@/lib/rng"
import { BREEDS, breedFor, cowSeed } from "./breeds"

describe("pasture breeds", () => {
  test("every breed has a usable coat and the catalogue is wide", () => {
    expect(BREEDS).toHaveLength(38)
    for (const breed of BREEDS) {
      expect(breed.body).toMatch(/^#[0-9a-f]{6}$/i)
      expect(breed.muzzle).toMatch(/^#[0-9a-f]{6}$/i)
      expect(["solid", "patches", "belt", "whiteface", "roan", "backstripe", "nguni"]).toContain(breed.pattern)
      expect(["none", "short", "long", "huge", "lyre"]).toContain(breed.horns)
      expect(breed.size).toBeGreaterThan(0)
      if (breed.pattern !== "solid") expect(breed.patch).toMatch(/^#[0-9a-f]{6}$/i)
    }
    expect(new Set(BREEDS.map((b) => b.id)).size).toBe(BREEDS.length)
    expect(BREEDS.filter((b) => b.pattern === "nguni").length).toBeGreaterThanOrEqual(2)
  })

  test("the six new breeds have distinct procedural looks", () => {
    const byId = new Map(BREEDS.map((breed) => [breed.id, breed]))
    expect(byId.get("kuroge-washu")).toMatchObject({ name: "Kuroge Washu", pattern: "solid", horns: "short" })
    expect(byId.get("akaushi")).toMatchObject({ name: "Akaushi", pattern: "solid", horns: "short" })
    expect(byId.get("nihon-tankaku")).toMatchObject({ name: "Nihon Tankaku", build: "broad", horns: "short" })
    expect(byId.get("mukaku")).toMatchObject({ name: "Mukaku", build: "compact-broad", horns: "none" })
    expect(byId.get("beefmaster")).toMatchObject({ name: "Beefmaster", build: "broad", dewlap: true, longEars: true, horns: "none" })
    expect(byId.get("aurochs")).toMatchObject({ name: "Aurochs", build: "broad", shaggy: true, horns: "long" })
    for (const id of ["kuroge-washu", "akaushi", "nihon-tankaku", "mukaku", "beefmaster", "aurochs"]) {
      expect(byId.get(id)?.hump).toBeUndefined()
    }
  })

  test("a PR is always the same cow, and a herd spreads across many breeds", () => {
    const pr = { repo: "coval-ai/backend", number: 7259 }
    expect(breedFor(pr)).toBe(breedFor({ ...pr }))
    expect(breedFor(pr)).toBe(BREEDS[hashString(`${pr.repo}#${pr.number}`) % BREEDS.length])
    expect(cowSeed(pr)).toBe(cowSeed({ ...pr }))
    expect(hashString("a")).not.toBe(hashString("b"))
    const herd = Array.from({ length: 300 }, (_, i) => breedFor({ repo: i % 2 ? "coval-ai/backend" : "coval-ai/frontend", number: 7000 + i }))
    expect(new Set(herd.map((b) => b.id)).size).toBeGreaterThanOrEqual(20)
  })
})
