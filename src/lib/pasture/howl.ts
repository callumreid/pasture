/**
 * The wolf's howl, synthesised: a breathy tone that climbs, holds with a
 * slow vibrato, and falls away. Bigger wolves howl lower. Resolves when done.
 */
export function howl(size = 1): Promise<void> {
  const Ctx = globalThis.AudioContext
  if (!Ctx) return Promise.resolve()
  const ctx = new Ctx()
  const now = ctx.currentTime
  const base = 330 / Math.max(0.7, size)
  const length = 2.6

  const voice = ctx.createOscillator()
  voice.type = "triangle"
  voice.frequency.setValueAtTime(base * 0.62, now)
  voice.frequency.exponentialRampToValueAtTime(base, now + 0.55)
  voice.frequency.setValueAtTime(base, now + 1.7)
  voice.frequency.exponentialRampToValueAtTime(base * 0.7, now + length)

  // A slow waver on the held note.
  const vibrato = ctx.createOscillator()
  vibrato.frequency.value = 5.2
  const depth = ctx.createGain()
  depth.gain.setValueAtTime(0, now)
  depth.gain.linearRampToValueAtTime(base * 0.02, now + 0.9)
  depth.gain.linearRampToValueAtTime(0, now + length)
  vibrato.connect(depth)
  depth.connect(voice.frequency)

  const filter = ctx.createBiquadFilter()
  filter.type = "lowpass"
  filter.Q.value = 2.5
  filter.frequency.setValueAtTime(600, now)
  filter.frequency.exponentialRampToValueAtTime(1900, now + 0.7)
  filter.frequency.exponentialRampToValueAtTime(500, now + length)

  const gain = ctx.createGain()
  gain.gain.setValueAtTime(0.0001, now)
  gain.gain.exponentialRampToValueAtTime(0.32, now + 0.35)
  gain.gain.setValueAtTime(0.32, now + 1.6)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + length)

  voice.connect(filter)
  filter.connect(gain)
  gain.connect(ctx.destination)
  vibrato.start(now)
  voice.start(now)
  vibrato.stop(now + length + 0.05)
  voice.stop(now + length + 0.05)
  return new Promise((resolve) => {
    voice.onended = () => {
      void ctx.close()
      resolve()
    }
  })
}
