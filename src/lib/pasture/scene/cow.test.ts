import * as THREE from "three"
import { describe, expect, test, vi } from "vitest"
import { BREEDS, type Breed } from "../breeds"

vi.mock("./atlas", async (importOriginal) => {
  const original = await importOriginal<typeof import("./atlas")>()
  return { ...original, atlasFor: () => new THREE.Texture() }
})

import { buildCow, buildHerdGeometry, disposeCow } from "./cow"

const newBreeds = BREEDS.filter((breed) => ["kuroge-washu", "akaushi", "nihon-tankaku", "mukaku", "beefmaster", "aurochs"].includes(breed.id))

describe("new cow shapes", () => {
  test("each breed builds in the full cow and instanced herd paths", () => {
    expect(newBreeds).toHaveLength(6)
    for (const breed of newBreeds) {
      const cow = buildCow({ id: breed.id, breed, seed: 42, pen: "awaiting", author: "test", collar: 0 })
      expect(cow.meshes).toHaveLength(7)
      expect(cow.meshes.every((mesh) => mesh.geometry.getAttribute("position").count > 0)).toBe(true)
      const herd = buildHerdGeometry(breed, 0.13)
      expect(herd.getAttribute("position").count).toBeGreaterThan(0)
      herd.dispose()
      disposeCow(cow)
    }
  })

  test("Mukaku adds no horn geometry in either detail level", () => {
    const mukaku = newBreeds.find((breed) => breed.id === "mukaku")!
    const horned: Breed = { ...mukaku, horns: "short" }
    const spec = { id: "mukaku", seed: 42, pen: "awaiting" as const, author: "test", collar: 0 }
    const cow = buildCow({ ...spec, breed: mukaku })
    const withHorns = buildCow({ ...spec, breed: horned })
    expect((cow.head.children[0] as THREE.Mesh).geometry.getAttribute("position").count)
      .toBeLessThan((withHorns.head.children[0] as THREE.Mesh).geometry.getAttribute("position").count)
    const herd = buildHerdGeometry(mukaku, 0.13)
    const hornedHerd = buildHerdGeometry(horned, 0.13)
    expect(herd.getAttribute("position").count).toBeLessThan(hornedHerd.getAttribute("position").count)
    herd.dispose()
    hornedHerd.dispose()
    disposeCow(cow)
    disposeCow(withHorns)
  })
})
