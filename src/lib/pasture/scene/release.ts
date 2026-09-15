import * as THREE from "three"
import type { ReleaseEvent, ReleasePhase } from "../releases"
import { buildUfo, stepUfo } from "./ufo"

export type ReleaseSceneEvent = Pick<ReleaseEvent, "label" | "phase">

const STRENGTH: Record<ReleasePhase, number> = {
  scheduled: 0.24,
  queued: 0.4,
  testing: 0.56,
  deploying: 1,
  verifying: 0.84,
  succeeded: 0.46,
  failed: 0.92,
}

function buildServiceBadge(scene: THREE.Scene) {
  const canvas = document.createElement("canvas")
  canvas.width = 1024
  canvas.height = 256
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0, depthTest: false })
  const sprite = new THREE.Sprite(material)
  sprite.renderOrder = 100
  sprite.visible = false
  scene.add(sprite)

  const paint = (event: ReleaseSceneEvent) => {
    const ctx = canvas.getContext("2d")!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.beginPath()
    ctx.roundRect(12, 12, canvas.width - 24, canvas.height - 24, 46)
    ctx.fillStyle = "rgba(24, 19, 34, 0.9)"
    ctx.fill()
    ctx.lineWidth = 9
    ctx.strokeStyle = event.phase === "failed" ? "#ff6f89" : event.phase === "succeeded" ? "#6fffc1" : "#bc9bff"
    ctx.stroke()
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillStyle = ctx.strokeStyle
    ctx.font = "800 30px system-ui, sans-serif"
    ctx.letterSpacing = "8px"
    ctx.fillText(event.phase.toUpperCase(), canvas.width / 2, 63)
    ctx.letterSpacing = "0px"
    const label = event.label.slice(0, 48)
    let size = 88
    do {
      ctx.font = `900 ${size}px system-ui, sans-serif`
      size -= 4
    } while (ctx.measureText(label).width > canvas.width - 100 && size > 40)
    ctx.fillStyle = "#ffffff"
    ctx.fillText(label, canvas.width / 2, 157)
    texture.needsUpdate = true
    const width = Math.max(10, Math.min(19, 8 + label.length * 0.38))
    sprite.scale.set(width, width / 4, 1)
  }

  return { sprite, material, texture, paint }
}

/** A release turns the farm's usual little saucer into a distant mothership and electrical storm. */
export function createReleaseRig(scene: THREE.Scene) {
  const ship = buildUfo()
  ship.group.position.set(12, 42, -24)
  ship.group.scale.setScalar(2.2)
  scene.add(ship.group)
  const storm = new THREE.PointLight("#b990ff", 0, 110, 1.5)
  storm.position.set(8, 24, -18)
  scene.add(storm)
  const badge = buildServiceBadge(scene)
  let event: ReleaseSceneEvent | undefined
  let amount = 0

  return {
    set(next: ReleaseSceneEvent | undefined) {
      event = next
      if (next) badge.paint(next)
      if (next?.phase === "failed") {
        storm.color.set("#ff385b")
        ship.beamMaterial.color.set("#ff4d69")
      } else if (next?.phase === "succeeded") {
        storm.color.set("#6fffc1")
        ship.beamMaterial.color.set("#85ffd0")
      } else {
        storm.color.set("#b990ff")
        ship.beamMaterial.color.set("#9ef7ef")
      }
    },
    tick(t: number, dt: number) {
      const phase = event?.phase
      const target = phase ? STRENGTH[phase] : 0
      amount += (target - amount) * Math.min(1, dt * (target ? 0.7 : 1.4))
      ship.group.visible = amount > 0.01
      if (!ship.group.visible) {
        storm.intensity = 0
        badge.sprite.visible = false
        return
      }
      const scale = 2.15 + amount * 1.05
      ship.group.scale.setScalar(scale)
      ship.group.position.y = 43 - amount * 15 + Math.sin(t * 0.42) * 0.5
      ship.group.position.x = 12 + Math.sin(t * 0.18) * 3
      const beam = Math.max(0, (amount - 0.34) / 0.66)
      stepUfo(ship, t * 0.72, ship.group.position.y / scale - 0.7, beam)
      const charge = Math.max(0, Math.sin(t * 1.7) + Math.sin(t * 5.1) - 1.42)
      const lightning = charge * charge * 24
      const pulse = 1 + Math.sin(t * 3.2) * 0.12
      storm.intensity = amount * (phase === "deploying" || phase === "verifying" || phase === "failed" ? 8 * pulse + lightning : 3)
      badge.sprite.visible = amount > 0.32
      badge.material.opacity = Math.min(1, (amount - 0.32) * 7)
      badge.sprite.position.set(ship.group.position.x, ship.group.position.y - 2.2, ship.group.position.z + 3.5)
    },
    dispose() {
      badge.texture.dispose()
      badge.material.dispose()
    },
  }
}
