import * as THREE from "three"
import { mulberry32, hashString } from "@/lib/rng"
import { CRITTERS, FARMER_ID, FARMER_LINES, WOLF_LINES, wolfID, wolfSpec, type Critter } from "../critters"
import type { AlarmSeverity } from "../types"
import { LANE, lanePoint, towardPens, wrapLane } from "./lane"

const TAU = Math.PI * 2

const mat = (color: string, roughness = 0.9) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 })
/** Eyes: matte for the pets, lit from inside for a wolf. */
const eyeMat = (spec: Critter, roughness: number) =>
  spec.glow ? new THREE.MeshStandardMaterial({ color: spec.eyes, emissive: spec.eyes, emissiveIntensity: 1.2, roughness: 0.3, metalness: 0 }) : mat(spec.eyes, roughness)

/** How far off the lane the trees start; a wolf comes from there and goes back to it. */
const TREELINE = 20
/** Leaving wolves vanish once they are this far out. */
const GONE = 17

/** Signed shortest distance along the loop from `a` to `b`, in (-length/2, length/2]. */
const laneDelta = (a: number, b: number) => wrapLane(b - a + LANE.length / 2) - LANE.length / 2

function lerpAngle(from: number, to: number, amount: number) {
  let delta = ((to - from + Math.PI) % TAU) - Math.PI
  if (delta < -Math.PI) delta += TAU
  return from + delta * Math.min(1, amount)
}

type Parts = {
  group: THREE.Group
  rig: THREE.Group
  head: THREE.Group
  legs: THREE.Group[]
  arms: THREE.Group[]
  tail?: THREE.Group
  brows: THREE.Mesh[]
  smile?: THREE.Mesh
  frown?: THREE.Mesh
  /** Where the label floats, in rig units. */
  top: number
}

// ---------------------------------------------------------------- builders

function shadowed<T extends THREE.Object3D>(object: T) {
  object.castShadow = true
  return object
}

function buildDog(spec: Critter): Parts {
  const group = new THREE.Group()
  const rig = new THREE.Group()
  rig.scale.setScalar(spec.size)
  group.add(rig)
  const coat = mat(spec.body)
  const patch = mat(spec.patch ?? spec.body)
  const dark = mat("#1d1917", 0.7)

  const legLength = spec.legs === "short" ? 0.42 : 0.72
  const bodyY = legLength + 0.34
  const body = shadowed(new THREE.Mesh(new THREE.CapsuleGeometry(0.42, spec.legs === "short" ? 1.25 : 1.05, 6, 14), coat))
  body.rotation.x = Math.PI / 2
  body.position.y = bodyY
  rig.add(body)
  if (spec.patch) {
    const chest = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), patch)
    chest.scale.set(1, 0.85, 0.6)
    chest.position.set(0, bodyY - 0.14, 0.62)
    rig.add(chest)
  }

  const head = new THREE.Group()
  head.position.set(0, bodyY + 0.36, 0.82)
  rig.add(head)
  const skull = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.38, 16, 12), coat))
  head.add(skull)
  const snout = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.26, 0.36), spec.patch ? patch : coat)
  snout.position.set(0, -0.1, 0.38)
  head.add(snout)
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), dark)
  nose.position.set(0, -0.03, 0.57)
  head.add(nose)
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), eyeMat(spec, 0.4))
    eye.position.set(side * 0.16, 0.1, 0.3)
    head.add(eye)
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 8), coat)
    if (spec.ears === "floppy") {
      ear.scale.set(0.55, 1, 0.35)
      ear.position.set(side * 0.36, -0.02, -0.02)
      ear.rotation.z = side * 0.35
    } else {
      ear.scale.set(0.45, 0.9, 0.35)
      ear.position.set(side * 0.24, 0.42, -0.06)
      ear.rotation.z = side * -0.3
    }
    head.add(ear)
  }

  const legs: THREE.Group[] = []
  for (const [x, z] of [
    [-0.2, 0.4],
    [0.2, 0.4],
    [-0.2, -0.42],
    [0.2, -0.42],
  ]) {
    const pivot = new THREE.Group()
    pivot.position.set(x, legLength, z)
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.08, legLength, 8), coat)
    leg.position.y = -legLength / 2
    pivot.add(leg)
    const paw = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), spec.patch ? patch : coat)
    paw.position.set(0, -legLength + 0.04, 0.04)
    pivot.add(paw)
    rig.add(pivot)
    legs.push(pivot)
  }

  const tail = new THREE.Group()
  tail.position.set(0, bodyY + 0.22, -0.62)
  const tailMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.6, 6), coat)
  tailMesh.position.set(0, 0.22, -0.16)
  tailMesh.rotation.x = -0.75
  tail.add(tailMesh)
  rig.add(tail)

  return { group, rig, head, legs, arms: [], tail, brows: [], top: bodyY + 0.95 }
}

/** A wolf is a dog with a longer muzzle, a brush of a tail, raised hackles and eyes that shine. */
function buildWolf(spec: Critter): Parts {
  const parts = buildDog(spec)
  const coat = mat(spec.body)
  const light = mat(spec.patch ?? spec.body)
  const bodyY = 0.72 + 0.34
  const muzzle = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.24, 0.52), coat))
  muzzle.position.set(0, -0.12, 0.48)
  parts.head.add(muzzle)
  const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.08, 0.4), light)
  jaw.position.set(0, -0.23, 0.44)
  parts.head.add(jaw)
  const hackles = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.46, 12, 10), coat))
  hackles.scale.set(1, 0.72, 0.9)
  hackles.position.set(0, bodyY + 0.14, 0.32)
  parts.rig.add(hackles)
  if (parts.tail) {
    const brush = new THREE.Mesh(new THREE.CapsuleGeometry(0.14, 0.5, 4, 8), light)
    brush.position.set(0, 0.28, -0.3)
    brush.rotation.x = -1.1
    parts.tail.add(brush)
  }
  return parts
}

function buildCat(spec: Critter): Parts {
  const group = new THREE.Group()
  const rig = new THREE.Group()
  rig.scale.setScalar(spec.size)
  group.add(rig)
  const coat = mat(spec.body, 0.85)
  const pink = mat("#d98a8a")

  const legLength = 0.55
  const bodyY = legLength + 0.3
  const body = shadowed(new THREE.Mesh(new THREE.CapsuleGeometry(0.34, 1.05, 6, 14), coat))
  body.rotation.x = Math.PI / 2
  body.position.y = bodyY
  rig.add(body)

  const head = new THREE.Group()
  head.position.set(0, bodyY + 0.3, 0.74)
  rig.add(head)
  head.add(shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 12), coat)))
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), coat)
  muzzle.scale.set(1.2, 0.7, 0.8)
  muzzle.position.set(0, -0.1, 0.26)
  head.add(muzzle)
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 5), pink)
  nose.position.set(0, -0.05, 0.38)
  head.add(nose)
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), mat(spec.eyes, 0.3))
    eye.position.set(side * 0.14, 0.07, 0.27)
    head.add(eye)
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 5), mat("#111111", 0.3))
    pupil.scale.set(0.5, 1.4, 1)
    pupil.position.set(side * 0.14, 0.07, 0.335)
    head.add(pupil)
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.3, 4), coat)
    ear.position.set(side * 0.19, 0.36, -0.02)
    ear.rotation.z = side * -0.35
    ear.rotation.y = Math.PI / 4
    head.add(ear)
  }

  const legs: THREE.Group[] = []
  for (const [x, z] of [
    [-0.16, 0.36],
    [0.16, 0.36],
    [-0.16, -0.38],
    [0.16, -0.38],
  ]) {
    const pivot = new THREE.Group()
    pivot.position.set(x, legLength, z)
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, legLength, 8), coat)
    leg.position.y = -legLength / 2
    pivot.add(leg)
    rig.add(pivot)
    legs.push(pivot)
  }

  const tail = new THREE.Group()
  tail.position.set(0, bodyY + 0.12, -0.55)
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0.3, -0.35),
    new THREE.Vector3(0, 0.75, -0.45),
    new THREE.Vector3(0, 1.0, -0.25),
  ])
  tail.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.045, 6, false), coat))
  rig.add(tail)

  return { group, rig, head, legs, arms: [], tail, brows: [], top: bodyY + 0.9 }
}

/** Kobi: black hoodie, brown pants, black sneakers, and the straw hat that makes him the farmer. */
function buildFarmer(spec: Critter): Parts {
  const group = new THREE.Group()
  const rig = new THREE.Group()
  group.add(rig)
  const hoodie = mat(spec.body)
  const pants = mat("#6b4a2d")
  const shoe = mat("#111111", 0.6)
  const skin = mat("#e8b892")
  const straw = mat("#d9b660", 1)
  const dark = mat("#1d1917", 0.7)
  const wood = mat("#8a6238", 1)
  const steel = mat("#9aa0a6", 0.4)

  const legs: THREE.Group[] = []
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group()
    pivot.position.set(side * 0.17, 1.02, 0)
    const leg = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.12, 1.0, 10), pants))
    leg.position.y = -0.5
    pivot.add(leg)
    const sneaker = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.16, 0.44), shoe)
    sneaker.position.set(0, -0.96, 0.08)
    pivot.add(sneaker)
    rig.add(pivot)
    legs.push(pivot)
  }
  const torso = shadowed(new THREE.Mesh(new THREE.CapsuleGeometry(0.36, 0.55, 6, 14), hoodie))
  torso.position.y = 1.55
  rig.add(torso)
  const hood = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), hoodie)
  hood.scale.set(1.1, 0.6, 0.8)
  hood.position.set(0, 1.98, -0.16)
  rig.add(hood)

  const arms: THREE.Group[] = []
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group()
    pivot.position.set(side * 0.46, 1.86, 0)
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.62, 4, 10), hoodie)
    arm.position.y = -0.42
    pivot.add(arm)
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6), skin)
    hand.position.y = -0.86
    pivot.add(hand)
    if (side > 0) {
      // A pitchfork, carried upright in the right hand.
      const fork = new THREE.Group()
      fork.position.set(0.05, -0.86, 0.05)
      const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.1, 6), wood)
      handle.position.y = 0.35
      fork.add(handle)
      for (const dx of [-0.11, 0, 0.11]) {
        const tine = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.008, 0.36, 5), steel)
        tine.position.set(dx, 1.58, 0)
        fork.add(tine)
      }
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.04, 0.04), steel)
      bar.position.y = 1.4
      fork.add(bar)
      pivot.add(fork)
    }
    rig.add(pivot)
    arms.push(pivot)
  }

  const head = new THREE.Group()
  head.position.set(0, 2.28, 0)
  rig.add(head)
  head.add(shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.31, 16, 12), skin)))
  const brows: THREE.Mesh[] = []
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), dark)
    eye.position.set(side * 0.11, 0.04, 0.28)
    head.add(eye)
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.03, 0.03), dark)
    brow.position.set(side * 0.11, 0.14, 0.28)
    head.add(brow)
    brows.push(brow)
  }
  const smile = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.025, 0.03), dark)
  smile.position.set(0, -0.12, 0.29)
  head.add(smile)
  const frown = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.014, 6, 12, Math.PI), dark)
  frown.position.set(0, -0.17, 0.29)
  frown.visible = false
  head.add(frown)
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.66, 0.05, 20), straw)
  brim.position.y = 0.24
  head.add(brim)
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.32, 16), straw)
  crown.position.y = 0.42
  head.add(crown)
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.345, 0.345, 0.07, 16), mat("#5a3a24"))
  band.position.y = 0.3
  head.add(band)

  return { group, rig, head, legs, arms, brows, smile, frown, top: 3.0 }
}

// ---------------------------------------------------------------- the runners

type Mode = "go" | "rest" | "inspect" | "grumpy"

type Runner = {
  spec: Critter
  parts: Parts
  /** Set for a wolf; `leaving` once its alarm has cleared and it is heading back to the trees. */
  wolf?: { severity: AlarmSeverity; leaving: boolean }
  s: number
  dir: 1 | -1
  offset: number
  offsetTarget: number
  speed: number
  cruise: number
  mode: Mode
  timer: number
  phase: number
  gait: number
  heading: number
  hop: number
  grump: number
  /** For followers: how far behind the leader they like to be, and a slowly changing whim on top. */
  gap: number
  whim: number
  x: number
  z: number
  rand: () => number
}

export type WolfSpec = { id: string; severity: AlarmSeverity }

export type CritterField = {
  root: THREE.Group
  tick(dt: number, t: number, camera: THREE.Camera): void
  /** One wolf per alarm; new ones come out of the trees, cleared ones go back. Returns the ids that just arrived. */
  setWolves(wolves: WolfSpec[]): string[]
  /** Click: the farmer stops and tells you off (returns his line); a pet does a happy hop. */
  poke(id: string): string | undefined
  position(id: string): { x: number; y: number; z: number } | undefined
  dispose(): void
}

export function createCritters(scene: THREE.Scene): CritterField {
  const root = new THREE.Group()
  scene.add(root)
  const runners = new Map<string, Runner>()
  let lastLine = -1

  let wolfCount = 0

  function spawn(spec: Critter, s: number): Runner {
    const rand = mulberry32(hashString(spec.id))
    const parts = spec.kind === "dog" ? buildDog(spec) : spec.kind === "cat" ? buildCat(spec) : spec.kind === "wolf" ? buildWolf(spec) : buildFarmer(spec)
    parts.rig.traverse((object) => {
      object.userData.critterID = spec.id
    })
    root.add(parts.group)
    const runner: Runner = {
      spec,
      parts,
      s,
      dir: rand() < 0.5 ? 1 : -1,
      offset: 0.6 + rand() * 1.4,
      offsetTarget: 0.6 + rand() * 1.4,
      speed: spec.speed,
      cruise: spec.speed,
      mode: "go",
      timer: 2 + rand() * 6,
      phase: rand() * TAU,
      gait: rand() * TAU,
      heading: 0,
      hop: 0,
      grump: 0,
      gap: 0,
      whim: 0,
      x: 0,
      z: 0,
      rand,
    }
    if (spec.kind === "farmer") runner.dir = 1
    runners.set(spec.id, runner)
    return runner
  }

  CRITTERS.forEach((spec, index) => {
    const rand = mulberry32(hashString(spec.id))
    spawn(spec, (LANE.length / CRITTERS.length) * index + rand() * 8)
  })

  /** A wolf steps out of the trees behind the back fence and lopes the lane against the farmer. */
  function spawnWolf(alarmID: string, severity: AlarmSeverity) {
    const runner = spawn(wolfSpec(alarmID, severity), LANE.width + LANE.depth + Math.random() * LANE.width)
    runner.wolf = { severity, leaving: false }
    runner.dir = -1
    runner.offset = TREELINE
    runner.offsetTarget = 3.5 + runner.rand() * 2
    runner.mode = "go"
    runner.cruise = runner.spec.speed
    runner.timer = 4 + runner.rand() * 4
    place(runner, 0)
    runner.heading = lanePoint(runner.s).heading + Math.PI
    runner.parts.group.position.set(runner.x, 0, runner.z)
    runner.parts.group.rotation.y = runner.heading
    return runner
  }

  function disposeGroup(group: THREE.Object3D) {
    group.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (!material) return
      for (const item of Array.isArray(material) ? material : [material]) item.dispose()
    })
  }

  function remove(runner: Runner) {
    runners.delete(runner.spec.id)
    root.remove(runner.parts.group)
    disposeGroup(runner.parts.group)
  }

  /** The nearest wolf to a point, for the farmer to glare at. */
  function nearestWolf(x: number, z: number) {
    let best: Runner | undefined
    let bestD = Infinity
    for (const runner of runners.values()) {
      if (!runner.wolf) continue
      const d = (runner.x - x) ** 2 + (runner.z - z) ** 2
      if (d < bestD) {
        bestD = d
        best = runner
      }
    }
    return best
  }
  // Followers start on their leader's heels, each a little further back.
  let trailing = 0
  for (const runner of runners.values()) {
    if (!runner.spec.follows) continue
    const leader = runners.get(runner.spec.follows)
    if (!leader) continue
    runner.gap = 2.6 + trailing * 2.2
    trailing++
    runner.s = wrapLane(leader.s - leader.dir * runner.gap)
    runner.dir = leader.dir
    runner.offset = leader.offset + 0.8 + trailing * 0.5
    runner.offsetTarget = runner.offset
  }

  function place(runner: Runner, dt: number) {
    const point = lanePoint(runner.s, runner.offset)
    runner.x = point.x
    runner.z = point.z
    const forward = runner.dir > 0 ? point.heading : point.heading + Math.PI
    return forward
  }

  function stepRunner(runner: Runner, dt: number, t: number, camera: THREE.Camera) {
    const { parts, spec } = runner
    runner.timer -= dt
    runner.hop = Math.max(0, runner.hop - dt * 2.2)
    // Drift sideways a little so they do not all run the same line.
    if (runner.wolf) {
      if (!runner.wolf.leaving && runner.rand() < dt * 0.2) runner.offsetTarget = 3 + runner.rand() * 3
    } else if (runner.rand() < dt * 0.3) runner.offsetTarget = 0.5 + runner.rand() * (spec.kind === "farmer" ? 1 : 2.2)
    runner.offset += (runner.offsetTarget - runner.offset) * Math.min(1, dt * 0.8)

    // Followers stay on their leader's heels; when there are wolves, every pet is a follower.
    const leaderID = spec.follows ?? (runner.gap > 0 && !runner.wolf && spec.kind !== "farmer" ? FARMER_ID : undefined)
    const leader = leaderID ? runners.get(leaderID) : undefined
    if (leader && runner.mode !== "grumpy") {
      // Stay on the leader's heels: a spot `gap` behind him, with a whim that
      // sometimes sends them darting ahead and drifting back.
      if (runner.timer <= 0) {
        runner.whim = runner.rand() < 0.3 ? -(2 + runner.rand() * 4) : (runner.rand() - 0.5) * 2
        runner.timer = 2 + runner.rand() * 5
      }
      const wanted = wrapLane(leader.s - leader.dir * (runner.gap + runner.whim))
      const delta = laneDelta(runner.s, wanted)
      const distance = Math.abs(delta)
      const leaderStill = leader.mode !== "go"
      if (distance > (leaderStill ? 0.6 : 0.35)) {
        runner.mode = "go"
        const chase = Math.min(spec.speed * 2.4, 0.9 + distance * 1.4)
        runner.speed += (chase - runner.speed) * Math.min(1, dt * 3)
        const step = Math.sign(delta) * Math.min(distance, runner.speed * dt)
        runner.s = wrapLane(runner.s + step)
        runner.dir = delta >= 0 ? 1 : -1
        const forward = place(runner, dt)
        runner.heading = lerpAngle(runner.heading, forward, dt * 5)
        runner.gait += dt * (4 + runner.speed * 2.2)
        const swing = Math.sin(runner.gait) * 0.6
        parts.legs[0].rotation.x = swing
        parts.legs[3].rotation.x = swing
        parts.legs[1].rotation.x = -swing
        parts.legs[2].rotation.x = -swing
        parts.rig.position.y = Math.abs(Math.sin(runner.gait)) * (0.05 + runner.speed * 0.02)
        parts.head.rotation.x = Math.sin(runner.gait) * 0.08
        parts.head.rotation.y = Math.sin(t * 1.3 + runner.phase) * 0.2
      } else {
        // Close enough: face him and wait, or lean, depending on who you are.
        runner.mode = "rest"
        runner.speed = 0
        place(runner, dt)
        const face = Math.atan2(leader.x - runner.x, leader.z - runner.z)
        runner.heading = lerpAngle(runner.heading, face, dt * 3)
        for (const leg of parts.legs) leg.rotation.x *= 1 - Math.min(1, dt * 6)
        parts.rig.position.y += (0 - parts.rig.position.y) * Math.min(1, dt * 6)
        parts.rig.rotation.z = spec.id === "bean" ? Math.sin(t * 0.6 + runner.phase) * 0.12 : 0
        parts.head.rotation.x += (-0.1 - parts.head.rotation.x) * Math.min(1, dt * 3)
        parts.head.rotation.y = Math.sin(t * 0.9 + runner.phase) * 0.4
      }
    } else if (runner.mode === "go") {
      runner.speed += (runner.cruise - runner.speed) * Math.min(1, dt * 1.5)
      runner.s = wrapLane(runner.s + runner.dir * runner.speed * dt)
      const forward = place(runner, dt)
      runner.heading = lerpAngle(runner.heading, forward, dt * 4)
      runner.gait += dt * (spec.kind === "farmer" ? 5.5 : 4 + runner.speed * 2.2)
      const swing = Math.sin(runner.gait) * (spec.kind === "farmer" ? 0.45 : 0.6)
      if (spec.kind === "farmer") {
        parts.legs[0].rotation.x = swing
        parts.legs[1].rotation.x = -swing
        parts.arms[0].rotation.x = -swing * 0.6
        parts.arms[1].rotation.x = swing * 0.25
        parts.rig.position.y = Math.abs(Math.sin(runner.gait)) * 0.03
        parts.head.rotation.y = Math.sin(t * 0.8 + runner.phase) * 0.25
      } else {
        parts.legs[0].rotation.x = swing
        parts.legs[3].rotation.x = swing
        parts.legs[1].rotation.x = -swing
        parts.legs[2].rotation.x = -swing
        const bound = spec.kind === "dog" ? 0.06 + runner.speed * 0.02 : 0.03
        parts.rig.position.y = Math.abs(Math.sin(runner.gait)) * bound
        // A wolf lopes low, head down, eyes on the pens.
        parts.head.rotation.x = runner.wolf ? 0.28 + Math.sin(runner.gait) * 0.06 : Math.sin(runner.gait) * 0.08
        parts.head.rotation.y = runner.wolf ? Math.sin(t * 0.7 + runner.phase) * 0.35 - 0.25 : Math.sin(t * 1.3 + runner.phase) * 0.2
      }
      if (runner.timer <= 0) {
        const roll = runner.rand()
        if (runner.wolf) {
          if (runner.wolf.leaving) runner.timer = 99
          else if (roll < 0.5) {
            // Stop at the fence and stare.
            runner.mode = "inspect"
            runner.timer = 3 + runner.rand() * 5
          } else {
            runner.cruise = spec.speed * (0.7 + runner.rand() * 0.8)
            runner.timer = 3 + runner.rand() * 6
          }
        } else if (spec.kind === "farmer") {
          runner.mode = "inspect"
          runner.timer = (wolfCount ? 5 : 3) + runner.rand() * 4
        } else if (roll < 0.35) {
          runner.mode = "rest"
          runner.timer = 1.5 + runner.rand() * 4
        } else if (roll < 0.6) {
          // Zoomies.
          runner.cruise = spec.speed * (1.8 + runner.rand())
          runner.timer = 1.5 + runner.rand() * 2
        } else if (roll < 0.75) {
          runner.dir = runner.dir > 0 ? -1 : 1
          runner.cruise = spec.speed
          runner.timer = 2 + runner.rand() * 5
        } else {
          runner.cruise = spec.speed * (0.6 + runner.rand() * 0.6)
          runner.timer = 3 + runner.rand() * 6
        }
      }
    } else {
      // Standing still: rest, inspect the herd, or be grumpy at whoever clicked.
      runner.speed = 0
      for (const leg of parts.legs) leg.rotation.x *= 1 - Math.min(1, dt * 6)
      for (const arm of parts.arms) arm.rotation.x *= 1 - Math.min(1, dt * 6)
      parts.rig.position.y += (0 - parts.rig.position.y) * Math.min(1, dt * 6)
      if (runner.mode === "inspect") {
        const side = lanePoint(runner.s).side
        const wolf = spec.kind === "farmer" && wolfCount ? nearestWolf(runner.x, runner.z) : undefined
        const face = wolf ? Math.atan2(wolf.x - runner.x, wolf.z - runner.z) : towardPens(side)
        runner.heading = lerpAngle(runner.heading, face, dt * 3)
        if (runner.wolf) {
          parts.head.rotation.x += (0.2 - parts.head.rotation.x) * Math.min(1, dt * 3)
          parts.head.rotation.y = Math.sin(t * 0.5 + runner.phase) * 0.3
        } else parts.head.rotation.y = wolf ? 0 : Math.sin(t * 0.9 + runner.phase) * 0.5
      } else if (runner.mode === "grumpy") {
        const face = Math.atan2(camera.position.x - runner.x, camera.position.z - runner.z)
        runner.heading = lerpAngle(runner.heading, face, dt * 5)
        parts.head.rotation.y = 0
        parts.head.rotation.x = -0.08
      } else {
        parts.head.rotation.x += (spec.kind === "cat" ? 0.15 : -0.1 - parts.head.rotation.x) * Math.min(1, dt * 3)
        parts.head.rotation.y = Math.sin(t * 0.7 + runner.phase) * 0.5
      }
      if (runner.timer <= 0) {
        runner.mode = "go"
        runner.cruise = spec.speed
        runner.timer = (spec.kind === "farmer" ? 8 : 3) + runner.rand() * 8
        parts.head.rotation.x = 0
      }
    }

    // The face: grumpy brows and a frown fade in and out.
    runner.grump = runner.mode === "grumpy" ? Math.min(1, runner.grump + dt * 6) : Math.max(0, runner.grump - dt * 3)
    if (parts.brows.length) {
      parts.brows[0].rotation.z = -0.55 * runner.grump
      parts.brows[1].rotation.z = 0.55 * runner.grump
      parts.brows[0].position.y = 0.14 - 0.05 * runner.grump
      parts.brows[1].position.y = 0.14 - 0.05 * runner.grump
      if (parts.smile) parts.smile.visible = runner.grump < 0.5
      if (parts.frown) parts.frown.visible = runner.grump >= 0.5
      if (runner.mode === "grumpy") {
        // Arms crossed, more or less.
        parts.arms[0].rotation.x = -1.3 * runner.grump
        parts.arms[1].rotation.x = -1.3 * runner.grump
        parts.arms[0].rotation.z = 0.9 * runner.grump
        parts.arms[1].rotation.z = -0.9 * runner.grump
      } else {
        parts.arms[0].rotation.z *= 1 - Math.min(1, dt * 6)
        parts.arms[1].rotation.z *= 1 - Math.min(1, dt * 6)
      }
    }
    if (parts.tail) {
      const wag = runner.wolf
        ? Math.sin(t * 1.4 + runner.phase) * 0.12
        : spec.kind === "dog"
          ? Math.sin(t * (runner.mode === "go" ? 16 : 9) + runner.phase) * 0.55
          : Math.sin(t * 1.8 + runner.phase) * 0.35
      parts.tail.rotation.y = wag
      if (runner.wolf) parts.tail.rotation.x = -0.5
      if (spec.kind === "cat") parts.tail.rotation.x = Math.sin(t * 1.1 + runner.phase) * 0.15
    }

    const hop = Math.sin(Math.min(1, runner.hop) * Math.PI) * (spec.kind === "farmer" ? 0 : 0.9)
    parts.group.position.set(runner.x, hop, runner.z)
    parts.group.rotation.y = runner.heading
  }

  for (const runner of runners.values()) {
    place(runner, 0)
    runner.heading = lanePoint(runner.s).heading + (runner.dir > 0 ? 0 : Math.PI)
    runner.parts.group.position.set(runner.x, 0, runner.z)
    runner.parts.group.rotation.y = runner.heading
  }

  return {
    root,
    tick(dt, t, camera) {
      for (const runner of runners.values()) {
        stepRunner(runner, dt, t, camera)
        if (runner.wolf?.leaving && runner.offset > GONE) remove(runner)
      }
    },
    setWolves(wolves) {
      const wanted = new Map(wolves.map((wolf) => [wolfID(wolf.id), wolf]))
      const arrived: string[] = []
      for (const runner of runners.values()) {
        if (!runner.wolf || wanted.has(runner.spec.id) || runner.wolf.leaving) continue
        // Its page has cleared: back to the trees, at a trot.
        runner.wolf.leaving = true
        runner.offsetTarget = TREELINE
        runner.mode = "go"
        runner.cruise = runner.spec.speed * 1.5
        runner.timer = 99
      }
      for (const [id, wolf] of wanted) {
        const existing = runners.get(id)
        if (existing?.wolf) {
          if (existing.wolf.leaving) {
            // Fired again before it reached the trees: turn around.
            existing.wolf.leaving = false
            existing.offsetTarget = 3.5 + existing.rand() * 2
            existing.timer = 2
          }
          continue
        }
        spawnWolf(wolf.id, wolf.severity)
        arrived.push(id)
      }
      wolfCount = wolves.length
      // The pets run to the farmer and stay there while a wolf is about; afterwards they go back to their laps.
      let trailing = 0
      for (const runner of runners.values()) {
        if (runner.wolf || runner.spec.kind === "farmer") continue
        if (runner.spec.follows) {
          trailing++
          continue
        }
        if (wolfCount) {
          if (runner.gap === 0) {
            runner.gap = 2.6 + trailing * 2.2
            runner.hop = 1
            runner.mode = "go"
            runner.cruise = runner.spec.speed * 2.2
            runner.timer = 1
          }
          trailing++
        } else if (runner.gap > 0) {
          runner.gap = 0
          runner.mode = "go"
          runner.cruise = runner.spec.speed
          runner.timer = 2 + runner.rand() * 4
        }
      }
      return arrived
    },
    poke(id) {
      const runner = runners.get(id)
      if (!runner) return undefined
      if (runner.spec.id === FARMER_ID) {
        runner.mode = "grumpy"
        runner.timer = 4.5
        const lines = wolfCount ? WOLF_LINES : FARMER_LINES
        let pick = Math.floor(runner.rand() * lines.length)
        if (pick === lastLine) pick = (pick + 1) % lines.length
        lastLine = pick
        return lines[pick]
      }
      if (runner.wolf) {
        // It does not like that. It stops, and it looks at you.
        runner.hop = 0.6
        runner.mode = "inspect"
        runner.timer = 4
        return undefined
      }
      runner.hop = 1
      if (runner.mode !== "go") {
        runner.mode = "go"
        runner.timer = 3 + runner.rand() * 4
      }
      runner.cruise = runner.spec.speed * 2
      return undefined
    },
    position(id) {
      const runner = runners.get(id)
      if (!runner) return undefined
      return { x: runner.x, y: runner.parts.top * runner.spec.size + runner.parts.group.position.y, z: runner.z }
    },
    dispose() {
      scene.remove(root)
      disposeGroup(root)
    },
  }
}
