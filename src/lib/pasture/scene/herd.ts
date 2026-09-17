import * as THREE from "three"
import { mulberry32 } from "@/lib/rng"
import { COLLAR_PALETTE } from "../collars"
import { HERD_INSET, herdSlots, penFor, type MergedLayout } from "../pens"
import { atlasFor } from "./atlas"
import { LOW, buildHerdGeometry, collarParts, type CowSpec } from "./cow"
import { inPond } from "./scenery"

/**
 * The merged herd: every cow out back, drawn in a handful of instanced calls,
 * so a quarter's worth of merges (thousands of cows) costs the GPU about what
 * a few dozen rigged cows do. Each breed's low-detail body is one
 * InstancedMesh (two coats, so a breed is not a row of clones); every cow's
 * collar band and bell are two more, coloured per author; and the contact
 * shadows are one more. The cows stand about, turn to look at things and now
 * and then amble a few steps from home. A selected cow lifts off the ground
 * like a rigged one; a new arrival drops in from the sky.
 */

const TAU = Math.PI * 2
/** Coat offsets for a breed's two looks. */
const COATS = [0.13, 0.61]
const DROP_FROM = 14
const DIM = 0.42
/** Up to this many, the herd casts sun shadows; a herd of thousands is a carpet, and its shadows cost a second pass. */
const SHADOW_LIMIT = 1500

const ease = (u: number) => u * u * (3 - 2 * u)

function lerpAngle(from: number, to: number, amount: number) {
  let delta = ((to - from + Math.PI) % TAU) - Math.PI
  if (delta < -Math.PI) delta += TAU
  return from + delta * Math.min(1, amount)
}

export type HerdCow = {
  spec: CowSpec
  x: number
  z: number
  heading: number
  home: { x: number; z: number }
  walk?: { x: number; z: number }
  timer: number
  /** 0 on the ground, 1 fully lifted (selected). */
  lift: number
  /** Height still to fall on arrival. */
  drop: number
  dimmed: boolean
  /** Upsidedown time writes position.y and rotation.x/z here; they are read when the matrix is composed. */
  parts: { group: THREE.Object3D }
  fell: boolean
  rand: () => number
  batch: Batch
  /** Index in the batch's mesh. */
  slot: number
  /** Index in the herd-wide band, bell and shadow meshes. */
  index: number
  dirty: boolean
}

type Instanced = THREE.InstancedMesh<THREE.BufferGeometry, THREE.Material>

type Batch = {
  key: string
  mesh: Instanced
  material: THREE.MeshStandardMaterial
  cows: (HerdCow | undefined)[]
  free: number[]
}

export type Herd = {
  root: THREE.Group
  /** The whole herd: cows in `specs` order get their spots; `placed` cows keep the spot they were put down on. */
  set(specs: CowSpec[], layout: MergedLayout, placed: Map<string, { x: number; z: number; heading: number }>, seeded: boolean): void
  tick(dt: number, t: number): void
  has(id: string): boolean
  /** The cow under a raycast hit on one of the herd's meshes. */
  idOf(hit: THREE.Intersection): string | undefined
  /** Where a cow is: its feet, how high it is lifted, and its drawn size. */
  position(id: string): { x: number; y: number; z: number; size: number } | undefined
  select(id: string | undefined): void
  setFilter(authors: Set<string> | undefined): void
  /** For upsidedown time. */
  fallers(): Iterable<HerdCow>
  size(): number
  dispose(): void
}

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0)

/** A bigger InstancedMesh with the same instances, in place of the old one. */
function grow(mesh: Instanced, capacity: number, used: number): Instanced {
  const next = new THREE.InstancedMesh(mesh.geometry, mesh.material, capacity)
  next.frustumCulled = false
  next.castShadow = mesh.castShadow
  next.receiveShadow = mesh.receiveShadow
  next.raycast = mesh.raycast
  next.userData = mesh.userData
  const m = new THREE.Matrix4()
  const c = new THREE.Color()
  for (let i = 0; i < used; i++) {
    mesh.getMatrixAt(i, m)
    next.setMatrixAt(i, m)
    if (mesh.instanceColor) {
      mesh.getColorAt(i, c)
      next.setColorAt(i, c)
    }
  }
  for (let i = used; i < capacity; i++) next.setMatrixAt(i, ZERO)
  next.count = used
  next.instanceMatrix.needsUpdate = true
  if (next.instanceColor) next.instanceColor.needsUpdate = true
  mesh.parent?.add(next)
  mesh.parent?.remove(mesh)
  mesh.dispose()
  return next
}

export function createHerd(scene: THREE.Scene): Herd {
  const root = new THREE.Group()
  scene.add(root)
  const cows = new Map<string, HerdCow>()
  const batches = new Map<string, Batch>()
  const geometries = new Map<string, THREE.BufferGeometry>()
  let layout: MergedLayout | undefined
  let selectedID: string | undefined
  let filter: Set<string> | undefined
  let castShadows = true

  // Herd-wide meshes, indexed together: the collar bands, the bells and the shadows.
  const slots: (HerdCow | undefined)[] = []
  const freeSlots: number[] = []
  const { band: bandGeometry, bell: bellGeometries } = collarParts(0, LOW)
  const bellGeometry = bellGeometries[0]
  const bandMaterial = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.75, metalness: 0 })
  const bellMaterial = new THREE.MeshStandardMaterial({ color: "#d8a63e", roughness: 0.45, metalness: 0.35 })
  const shadowMaterial = new THREE.MeshBasicMaterial({ color: "#000000", transparent: true, opacity: 0.17, depthWrite: false })
  const noRaycast = () => {}
  const wide = (geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number): Instanced => {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity)
    mesh.frustumCulled = false
    mesh.raycast = noRaycast
    for (let i = 0; i < capacity; i++) mesh.setMatrixAt(i, ZERO)
    mesh.count = 0
    root.add(mesh)
    return mesh
  }
  let band = wide(bandGeometry, bandMaterial, 256)
  let bell = wide(bellGeometry, bellMaterial, 256)
  let shadow = wide(new THREE.CircleGeometry(1, 20), shadowMaterial, 256)
  const collarColors = COLLAR_PALETTE.map((hex) => new THREE.Color(hex))
  const white = new THREE.Color("#ffffff")
  const grey = new THREE.Color().setScalar(DIM)
  const scratch = new THREE.Color()

  const geometryFor = (spec: CowSpec) => {
    const coat = spec.seed & 1
    const key = `${spec.breed.id}:${coat}`
    let geometry = geometries.get(key)
    if (!geometry) {
      geometry = buildHerdGeometry(spec.breed, COATS[coat])
      geometry.computeBoundingSphere()
      geometries.set(key, geometry)
    }
    return { key, geometry }
  }

  const batchFor = (spec: CowSpec): Batch => {
    const { key, geometry } = geometryFor(spec)
    let batch = batches.get(key)
    if (!batch) {
      const material = new THREE.MeshStandardMaterial({ map: atlasFor(spec.breed), roughness: 0.92, metalness: 0 })
      const mesh: Instanced = new THREE.InstancedMesh(geometry, material, 64)
      mesh.frustumCulled = false
      mesh.castShadow = castShadows
      for (let i = 0; i < 64; i++) mesh.setMatrixAt(i, ZERO)
      mesh.count = 0
      batch = { key, mesh, material, cows: [], free: [] }
      mesh.userData.herdBatch = batch
      root.add(mesh)
      batches.set(key, batch)
    }
    return batch
  }

  const takeSlot = (batch: Batch) => {
    const slot = batch.free.pop() ?? batch.cows.length
    if (slot >= batch.mesh.instanceMatrix.count) batch.mesh = grow(batch.mesh, Math.max(slot + 1, batch.mesh.instanceMatrix.count * 2), batch.cows.length)
    if (slot >= batch.cows.length) batch.cows.length = slot + 1
    batch.mesh.count = batch.cows.length
    return slot
  }

  const takeIndex = () => {
    const index = freeSlots.pop() ?? slots.length
    if (index >= band.instanceMatrix.count) {
      const capacity = Math.max(index + 1, band.instanceMatrix.count * 2)
      band = grow(band, capacity, slots.length)
      bell = grow(bell, capacity, slots.length)
      shadow = grow(shadow, capacity, slots.length)
    }
    if (index >= slots.length) slots.length = index + 1
    band.count = bell.count = shadow.count = slots.length
    return index
  }

  const dummy = new THREE.Object3D()
  const flat = new THREE.Object3D()
  flat.rotation.x = -Math.PI / 2
  const touched = new Set<Instanced>()

  function compose(cow: HerdCow) {
    const size = cow.spec.breed.size * (layout?.scale ?? 1)
    const g = cow.parts.group
    const lifted = ease(cow.lift)
    dummy.position.set(cow.x, g.position.y + cow.drop + lifted * (2.3 + size * 0.5), cow.z)
    dummy.rotation.set(g.rotation.x, cow.heading, g.rotation.z)
    dummy.scale.setScalar(size)
    dummy.updateMatrix()
    cow.batch.mesh.setMatrixAt(cow.slot, dummy.matrix)
    band.setMatrixAt(cow.index, dummy.matrix)
    bell.setMatrixAt(cow.index, dummy.matrix)
    const shrink = cow.drop > 0 ? Math.max(0.15, 1 - cow.drop / DROP_FROM) : 1 - lifted * 0.35
    flat.position.set(cow.x, 0.02, cow.z)
    flat.scale.setScalar(0.95 * size * shrink)
    flat.updateMatrix()
    shadow.setMatrixAt(cow.index, flat.matrix)
    touched.add(cow.batch.mesh).add(band).add(bell).add(shadow)
    cow.dirty = false
  }

  function paint(cow: HerdCow) {
    const dim = !!filter && !filter.has(cow.spec.author)
    cow.dimmed = dim
    cow.batch.mesh.setColorAt(cow.slot, dim ? grey : white)
    scratch.copy(collarColors[cow.spec.collar % collarColors.length] ?? white)
    if (dim) scratch.multiplyScalar(DIM)
    band.setColorAt(cow.index, scratch)
    bell.setColorAt(cow.index, dim ? grey : white)
    for (const mesh of [cow.batch.mesh, band, bell]) if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }

  function add(spec: CowSpec, x: number, z: number, heading: number, drop: number) {
    const rand = mulberry32(spec.seed ^ 0x51ed27)
    const batch = batchFor(spec)
    const cow: HerdCow = {
      spec,
      x,
      z,
      heading,
      home: { x, z },
      timer: 2 + rand() * 12,
      lift: 0,
      drop,
      dimmed: false,
      parts: { group: new THREE.Object3D() },
      fell: false,
      rand,
      batch,
      slot: takeSlot(batch),
      index: takeIndex(),
      dirty: true,
    }
    batch.cows[cow.slot] = cow
    slots[cow.index] = cow
    cows.set(spec.id, cow)
    paint(cow)
    compose(cow)
    return cow
  }

  function remove(cow: HerdCow) {
    cow.batch.mesh.setMatrixAt(cow.slot, ZERO)
    band.setMatrixAt(cow.index, ZERO)
    bell.setMatrixAt(cow.index, ZERO)
    shadow.setMatrixAt(cow.index, ZERO)
    touched.add(cow.batch.mesh).add(band).add(bell).add(shadow)
    cow.batch.cows[cow.slot] = undefined
    cow.batch.free.push(cow.slot)
    slots[cow.index] = undefined
    freeSlots.push(cow.index)
    cows.delete(cow.spec.id)
    spare.push(cow.home)
  }

  /** Homes given up by cows that left, for the next arrivals. */
  const spare: { x: number; z: number }[] = []
  let slotList: { x: number; z: number }[] = []
  let slotCursor = 0
  const avoid = (x: number, z: number) => inPond(x, z, 1.4)

  const nextHome = () => {
    const home = spare.pop()
    if (home) return home
    if (slotCursor >= slotList.length && layout) slotList = herdSlots(layout, Math.max(slotCursor + 64, slotList.length * 2), mulberry32(0x7e2d), avoid)
    return slotList[slotCursor++] ?? { x: 0, z: (layout?.rect.z1 ?? 3) - HERD_INSET }
  }

  function flush() {
    for (const mesh of touched) mesh.instanceMatrix.needsUpdate = true
    touched.clear()
  }

  return {
    root,
    set(specs, next, placed, seeded) {
      const relayout = !layout || layout.rect.z0 !== next.rect.z0 || layout.rect.x0 !== next.rect.x0 || layout.rect.x1 !== next.rect.x1 || layout.scale !== next.scale
      layout = next
      castShadows = specs.length <= SHADOW_LIMIT
      for (const batch of batches.values()) batch.mesh.castShadow = castShadows
      const wanted = new Set(specs.map((spec) => spec.id))
      for (const cow of [...cows.values()]) if (!wanted.has(cow.spec.id)) remove(cow)
      if (relayout) {
        // A new field: every cow gets a fresh spot, the newest merges at the front.
        spare.length = 0
        slotList = herdSlots(next, specs.length + 64, mulberry32(0x7e2d), avoid)
        slotCursor = 0
        for (const spec of specs) {
          const cow = cows.get(spec.id)
          if (!cow) continue
          const home = placed.get(spec.id) ?? nextHome()
          cow.home = { x: home.x, z: home.z }
          cow.x = home.x
          cow.z = home.z
          cow.walk = undefined
          cow.dirty = true
        }
        for (const batch of batches.values()) batch.mesh.boundingSphere = null
      }
      for (const spec of specs) {
        const cow = cows.get(spec.id)
        if (cow) {
          const repaint = cow.spec.collar !== spec.collar || cow.spec.author !== spec.author
          const rebuild = cow.spec.breed.id !== spec.breed.id || cow.spec.seed !== spec.seed
          cow.spec = spec
          if (rebuild) {
            const at = { x: cow.x, z: cow.z, heading: cow.heading }
            remove(cow)
            spare.pop()
            add(spec, at.x, at.z, at.heading, 0)
          } else if (repaint) paint(cow)
          continue
        }
        const at = placed.get(spec.id)
        if (at) add(spec, at.x, at.z, at.heading, 0)
        else {
          const home = nextHome()
          add(spec, home.x, home.z, mulberry32(spec.seed)() * TAU, seeded && !relayout ? DROP_FROM : 0)
        }
      }
      for (const cow of cows.values()) if (cow.dirty) compose(cow)
      flush()
    },
    tick(dt, t) {
      const scale = layout?.scale ?? 1
      const rect = penFor("merged").rect
      for (const cow of cows.values()) {
        let dirty = cow.dirty
        if (cow.drop > 0) {
          cow.drop = Math.max(0, cow.drop - dt * (10 + (DROP_FROM - cow.drop) * 2.2))
          dirty = true
        }
        const wantLift = cow.spec.id === selectedID
        if (wantLift) {
          if (cow.lift < 1) cow.lift = Math.min(1, cow.lift + dt * 1.5)
          // Hovering: a slow bob.
          cow.parts.group.position.y = Math.sin(t * 1.7 + cow.index) * 0.08 * ease(cow.lift)
          dirty = true
        } else if (cow.lift > 0) {
          cow.lift = Math.max(0, cow.lift - dt * 1.3)
          if (cow.lift === 0) cow.parts.group.position.y = 0
          dirty = true
        }
        const g = cow.parts.group
        const fallen = g.rotation.x !== 0 || g.rotation.z !== 0 || (g.position.y !== 0 && !wantLift)
        if (fallen || cow.fell) dirty = true
        cow.fell = fallen
        if (cow.lift <= 0.02 && cow.drop === 0 && !fallen) {
          cow.timer -= dt
          if (cow.walk) {
            const dx = cow.walk.x - cow.x
            const dz = cow.walk.z - cow.z
            const distance = Math.hypot(dx, dz)
            if (distance < 0.25 || cow.timer <= 0) {
              cow.walk = undefined
              cow.timer = 8 + cow.rand() * 16
            } else {
              cow.heading = lerpAngle(cow.heading, Math.atan2(dx, dz), dt * 2)
              const speed = 0.65 * scale * (0.85 + cow.spec.breed.size * 0.15)
              cow.x += Math.sin(cow.heading) * speed * dt
              cow.z += Math.cos(cow.heading) * speed * dt
              dirty = true
            }
          } else if (cow.timer <= 0) {
            if (cow.rand() < 0.3) {
              const angle = cow.rand() * TAU
              const reach = (0.6 + cow.rand() * 1.2) * scale
              const x = Math.max(rect.x0 + HERD_INSET, Math.min(rect.x1 - HERD_INSET, cow.home.x + Math.sin(angle) * reach))
              const z = Math.max(rect.z0 + HERD_INSET, Math.min(rect.z1 - HERD_INSET, cow.home.z + Math.cos(angle) * reach))
              if (!avoid(x, z)) cow.walk = { x, z }
              cow.timer = 3 + cow.rand() * 4
            } else {
              // A look around.
              cow.heading += (cow.rand() - 0.5) * 0.9
              cow.timer = 6 + cow.rand() * 14
              dirty = true
            }
          }
        }
        if (dirty) compose(cow)
      }
      flush()
    },
    has: (id) => cows.has(id),
    idOf(hit) {
      if (hit.instanceId === undefined) return undefined
      const batch = hit.object.userData.herdBatch as Batch | undefined
      return batch?.cows[hit.instanceId]?.spec.id
    },
    position(id) {
      const cow = cows.get(id)
      if (!cow) return undefined
      const size = cow.spec.breed.size * (layout?.scale ?? 1)
      return { x: cow.x, y: cow.parts.group.position.y + cow.drop + ease(cow.lift) * (2.3 + size * 0.5), z: cow.z, size }
    },
    select(id) {
      selectedID = id
    },
    setFilter(authors) {
      filter = authors
      for (const cow of cows.values()) {
        const dim = !!filter && !filter.has(cow.spec.author)
        if (dim !== cow.dimmed) paint(cow)
      }
    },
    fallers: () => cows.values(),
    size: () => cows.size,
    dispose() {
      scene.remove(root)
      for (const batch of batches.values()) {
        batch.mesh.dispose()
        batch.material.dispose()
      }
      for (const geometry of geometries.values()) geometry.dispose()
      for (const mesh of [band, bell, shadow]) {
        mesh.geometry.dispose()
        mesh.dispose()
      }
      bandMaterial.dispose()
      bellMaterial.dispose()
      shadowMaterial.dispose()
      cows.clear()
    },
  }
}
