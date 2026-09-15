"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { assignCollars, collarIndex } from "@/lib/pasture/collars"
import { FARMER_ID, critterByID } from "@/lib/pasture/critters"
import { advanceLimbo, buildMembers, penCounts, personCounts, type Limbo } from "@/lib/pasture/members"
import { moo } from "@/lib/pasture/moo"
import { primaryReleaseEvent, type ReleaseSnapshot } from "@/lib/pasture/releases"
import { createPastureScene, type CowSpec, type PastureScene, type PickTarget } from "@/lib/pasture/scene"
import { PASTURE_TIMEFRAMES, cowID, type Herd, type OpenMode, type Viewer } from "@/lib/pasture/types"
import { isWolf, wolfID, type AlertSummary } from "@/lib/pasture/wolves"
import { SAN_FRANCISCO, describeWeather, localClock, sunPosition, type Weather } from "@/lib/sky"
import { HoverCard } from "./HoverCard"
import { Inspector } from "./Inspector"
import { WhosWho, type WhosWhoPerson } from "./WhosWho"
import { ScopePicker } from "./ScopePicker"
import { ReleaseStatus } from "./ReleaseStatus"
import { plural, relative, timeframeLabel } from "./format"

/** Past this many the field turns into a stampede and the frame rate goes with it. */
const HERD_CAP = 300
/** While the field is open, GitHub is re-read this often so stage changes get their hand-of-god moment. */
const REFRESH_MS = 60_000
/** Release attempts move faster than pull requests, so integrations get a tighter poll. */
const RELEASE_REFRESH_MS = 10_000
const STORAGE_KEY = "pasture.settings"

type Settings = { scope: string; days: number; openMode: OpenMode; mooOnMove: boolean; tour: boolean }
type Loaded = { key: string; data: Herd }
type LoadedRelease = { scope: string; data: ReleaseSnapshot }

const settingsKey = (s: Settings) => `${s.scope}|${s.days}|${s.openMode}`

function readStoredSettings(fallback: Settings): Settings {
  const next = { ...fallback }
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Settings> | null
    if (stored?.scope) next.scope = stored.scope
    if (stored?.days && Number.isFinite(stored.days)) next.days = stored.days
    if (stored?.openMode === "all" || stored?.openMode === "active") next.openMode = stored.openMode
    if (typeof stored?.mooOnMove === "boolean") next.mooOnMove = stored.mooOnMove
    if (typeof stored?.tour === "boolean") next.tour = stored.tour
  } catch {
    // Storage can be missing or locked down; the defaults are fine.
  }
  const params = new URLSearchParams(window.location.search)
  const fromUrl = params.get("org")
  if (fromUrl) next.scope = fromUrl
  // `?moo=1` (or 0) is for a TV, which has nobody to click the bell.
  const mooParam = params.get("moo")
  if (mooParam === "1" || mooParam === "0") next.mooOnMove = mooParam === "1"
  // `?tour=1` turns the screensaver camera on; a TV wants that.
  const tourParam = params.get("tour")
  if (tourParam === "1" || tourParam === "0") next.tour = tourParam === "1"
  return next
}

/**
 * A green field with a pen for every stage of a pull request's life and one
 * cow per pull request on the team, each wearing its author's collar. Hover
 * a cow for its PR, click to lift it and read the details, double-click to
 * open it on GitHub. When a PR moves stage, the hand of god carries its cow
 * to the right pen.
 */
export default function Pasture(props: { defaultScope: string; tokenMode: boolean; releaseEnabled: boolean; signOut?: () => Promise<void> }) {
  const [settings, setSettings] = useState<Settings>({ scope: props.defaultScope, days: 1, openMode: "active", mooOnMove: false, tour: false })
  const [ready, setReady] = useState(false)
  const [viewer, setViewer] = useState<Viewer>()
  const [herd, setHerd] = useState<Loaded>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [limbo, setLimbo] = useState<Limbo>(new Map())
  const [hover, setHover] = useState<{ target: PickTarget; x: number; y: number }>()
  const [selected, setSelected] = useState<string>()
  const [bubble, setBubble] = useState<{ id: string; text: string; x: number; y: number }>()
  const [alerts, setAlerts] = useState<{ home: string | null; count: number; alerts: AlertSummary[] }>({ home: null, count: 0, alerts: [] })
  const [releases, setReleases] = useState<LoadedRelease>()
  const [weather, setWeather] = useState<Weather | null>(null)
  // `?sky=off` freezes the field at a nice afternoon, for screenshots and films. Read after mount so the server and client agree.
  const [liveSky, setLiveSky] = useState(true)
  useEffect(() => {
    setLiveSky(new URLSearchParams(window.location.search).get("sky") !== "off")
  }, [])
  const [focus, setFocus] = useState<string>()
  const [mooing, setMooing] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<PastureScene>(undefined)
  const shownKeyRef = useRef<string>(undefined)
  const limboKeyRef = useRef<string>(undefined)
  const previousOpenRef = useRef<Herd["open"]>(undefined)
  const key = settingsKey(settings)

  // Settings come from the URL, then whatever was used last time.
  useEffect(() => {
    setSettings((current) => readStoredSettings(current))
    setReady(true)
  }, [])
  useEffect(() => {
    if (!ready) return
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    } catch {
      // ignore
    }
    const url = new URL(window.location.href)
    url.searchParams.set("org", settings.scope)
    window.history.replaceState(null, "", url)
  }, [ready, settings])

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(tick)
  }, [])

  // The deployment's default organization may not be one of this person's; start them on theirs.
  useEffect(() => {
    if (!viewer || !ready) return
    setSettings((current) => {
      if (current.scope === "me" || viewer.orgs.some((org) => org.login === current.scope)) return current
      return { ...current, scope: viewer.orgs[0]?.login ?? "me" }
    })
  }, [viewer, ready])

  useEffect(() => {
    let cancelled = false
    fetch("/api/orgs", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) window.location.assign("/")
        const body = (await response.json()) as Viewer & { error?: string }
        if (!response.ok) throw new Error(body.error ?? response.statusText)
        if (!cancelled) setViewer(body)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const load = useCallback(
    async (signal?: AbortSignal, fresh = false) => {
      setLoading(true)
      try {
        const params = new URLSearchParams({ scope: settings.scope, days: String(settings.days), open: settings.openMode })
        if (fresh) params.set("fresh", "1")
        const response = await fetch(`/api/herd?${params}`, { signal, cache: "no-store" })
        if (response.status === 401) {
          window.location.assign("/")
          return
        }
        const body = (await response.json()) as Herd & { error?: string }
        if (!response.ok) throw new Error(body.error ?? response.statusText)
        setHerd({ key, data: body })
        setError(undefined)
      } catch (cause) {
        if (signal?.aborted) return
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!signal?.aborted) setLoading(false)
      }
    },
    [settings, key],
  )

  // Firing alerts become wolves; the route answers quietly for any field but the home organization.
  const loadAlerts = useCallback(async () => {
    try {
      const response = await fetch(`/api/alerts?scope=${encodeURIComponent(settings.scope)}`, { cache: "no-store" })
      if (!response.ok) return
      const body = (await response.json()) as { home: string | null; count: number; alerts: AlertSummary[] }
      setAlerts({ home: body.home, count: body.count, alerts: body.alerts ?? [] })
    } catch {
      // A missed poll just leaves last minute's wolves where they are.
    }
  }, [settings.scope])
  useEffect(() => {
    if (!ready) return
    void loadAlerts()
    const timer = setInterval(() => void loadAlerts(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [ready, loadAlerts])
  const alertsById = useMemo(() => new Map(alerts.alerts.map((alert) => [wolfID(alert), alert])), [alerts])
  const alertsRef = useRef(alertsById)
  alertsRef.current = alertsById
  useEffect(() => sceneRef.current?.setWolves(alerts.alerts), [alerts])

  // Release integrations are optional and organization-scoped. An unconfigured field keeps the original merged-history pasture.
  const loadReleases = useCallback(async () => {
    try {
      const response = await fetch(`/api/releases?scope=${encodeURIComponent(settings.scope)}`, { cache: "no-store" })
      if (response.status === 401) {
        window.location.assign("/")
        return
      }
      if (!response.ok) return
      const body = (await response.json()) as ReleaseSnapshot
      setReleases({ scope: settings.scope, data: body })
    } catch {
      // Keep the last good picture. A release feed outage should not empty the field.
    }
  }, [settings.scope])
  useEffect(() => {
    if (!ready || !props.releaseEnabled) return
    void loadReleases()
    const timer = setInterval(() => void loadReleases(), RELEASE_REFRESH_MS)
    return () => clearInterval(timer)
  }, [ready, props.releaseEnabled, loadReleases])

  // The sky over the field is San Francisco's: the sun where it really is, the weather as it is.
  useEffect(() => {
    if (!liveSky) return
    let cancelled = false
    const poll = () =>
      fetch("/api/weather", { cache: "no-store" })
        .then(async (response) => (response.ok ? ((await response.json()) as Weather) : null))
        .then((w) => {
          if (!cancelled && w && !("error" in w)) setWeather(w)
        })
        .catch(() => undefined)
    void poll()
    const timer = setInterval(poll, 10 * 60_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [liveSky])
  useEffect(() => {
    if (!liveSky) return
    const sun = sunPosition(new Date(now))
    sceneRef.current?.setSky({ altitude: sun.altitude, azimuth: sun.azimuth, weather })
  }, [now, weather, liveSky])

  useEffect(() => {
    if (!ready) return
    const controller = new AbortController()
    void load(controller.signal)
    // Longer windows cost more searches per read, so they are re-read less often.
    const timer = setInterval(() => void load(undefined, true), settings.days <= 1 ? REFRESH_MS : REFRESH_MS * 3)
    const onVisible = () => {
      if (document.visibilityState === "visible") void load()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      controller.abort()
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [ready, load, settings.days])

  // Open PRs that just vanished are held in place until the merged search
  // catches up, so a merge reads as "carried to the merged pen", not "poof".
  useEffect(() => {
    if (!herd) return
    const at = Date.now()
    if (limboKeyRef.current !== herd.key) {
      limboKeyRef.current = herd.key
      previousOpenRef.current = undefined
      setLimbo(new Map())
    }
    const before = previousOpenRef.current ?? herd.data.open
    previousOpenRef.current = herd.data.open
    const merged = new Set(herd.data.merged.map(cowID))
    const closed = new Set(herd.data.closed.map(cowID))
    setLimbo((current) => advanceLimbo(current, before, herd.data.open, merged, at, closed))
  }, [herd])
  useEffect(() => {
    if (!herd) return
    const merged = new Set(herd.data.merged.map(cowID))
    setLimbo((current) => (current.size ? advanceLimbo(current, herd.data.open, herd.data.open, merged, now) : current))
  }, [now, herd])

  const data = herd?.key === key ? herd.data : undefined
  const releaseFeed = releases?.scope === settings.scope && releases.data.configured ? releases.data : undefined
  const releaseMode = Boolean(releaseFeed)
  const releaseEvent = useMemo(() => (releaseFeed ? primaryReleaseEvent(releaseFeed, now) : undefined), [releaseFeed, now])
  const closedIds = useMemo(() => new Set((data?.closed ?? []).map(cowID)), [data])
  const members = useMemo(
    () => (data ? buildMembers(data.open, releaseFeed?.waiting ?? data.merged, limbo, HERD_CAP, releaseFeed?.recent ?? [], releaseMode) : []),
    [data, limbo, releaseFeed, releaseMode],
  )
  const byId = useMemo(() => new Map(members.map((member) => [member.id, member])), [members])
  const byIdRef = useRef(byId)
  byIdRef.current = byId
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const collars = useMemo(() => assignCollars(members.map((member) => member.author)), [members])
  const counts = useMemo(() => penCounts(members), [members])
  const avatars = useMemo(() => {
    const result = new Map((data?.people ?? []).map((person) => [person.login, person.avatarUrl]))
    for (const member of members) if (!result.has(member.author)) result.set(member.author, member.pr.authorAvatar)
    return result
  }, [data, members])
  const people = useMemo<WhosWhoPerson[]>(
    () => [...personCounts(members).keys()].sort().map((login) => ({ login, avatarUrl: avatars.get(login) ?? null, collar: collars.get(login) })),
    [members, avatars, collars],
  )
  const specs = useMemo<CowSpec[]>(
    () =>
      members.map((member) => ({
        id: member.id,
        breed: member.breed,
        seed: member.seed,
        pen: member.pen,
        author: member.author,
        collar: collarIndex(collars.get(member.author) ?? ""),
        queued: member.kind === "open" && member.pr.state === "merge-queue",
      })),
    [members, collars],
  )
  const current = selected ? byId.get(selected) : undefined
  const hoveredCow = hover?.target.kind === "cow" ? byId.get(hover.target.id) : undefined
  const hoveredCritter = hover?.target.kind === "critter" && !isWolf(hover.target.id) ? critterByID(hover.target.id) : undefined
  const hoveredWolf = hover?.target.kind === "critter" && isWolf(hover.target.id) ? alertsById.get(hover.target.id) : undefined
  const releaseModeRef = useRef(releaseMode)
  releaseModeRef.current = releaseMode
  const releaseEventRef = useRef(releaseEvent)
  releaseEventRef.current = releaseEvent

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const local = (x: number, y: number) => {
      const rect = hostRef.current?.getBoundingClientRect()
      return rect ? { x: x - rect.left, y: y - rect.top } : { x, y }
    }
    const scene = createPastureScene(canvas, {
      onHover: (target, x, y) => setHover(target ? { target, ...local(x, y) } : undefined),
      onSelect: (target) => {
        if (!target || target.kind === "cow") {
          setSelected(target?.id)
          return
        }
        const alert = alertsRef.current.get(target.id)
        if (alert) {
          window.open(alert.url, "_blank", "noopener")
          return
        }
        const line = scene.poke(target.id)
        if (line) {
          const at = scene.screenPosition(target.id)
          setBubble({ id: target.id, text: line, x: at?.x ?? 0, y: at?.y ?? 0 })
        }
      },
      onOpen: (id) => {
        const member = byIdRef.current.get(id)
        if (member) window.open(member.pr.url, "_blank", "noopener")
      },
      onCarry: (id) => {
        if (!settingsRef.current.mooOnMove) return
        const member = byIdRef.current.get(id)
        void moo(member?.breed.size ?? 1).catch(() => undefined)
      },
      onBurn: (id) => {
        if (!settingsRef.current.mooOnMove) return
        const member = byIdRef.current.get(id)
        void moo((member?.breed.size ?? 1) * 0.8).catch(() => undefined)
      },
    })
    sceneRef.current = scene
    scene.setReleaseMode(releaseModeRef.current)
    scene.setRelease(releaseEventRef.current)
    if (liveSky) {
      const sun = sunPosition(new Date())
      scene.setSky({ altitude: sun.altitude, azimuth: sun.azimuth, weather: null })
    }
    // `?ufo=N` sets how often the saucer does the carrying (1 = always); for demos and TVs.
    const ufo = Number(new URLSearchParams(window.location.search).get("ufo"))
    if (Number.isFinite(ufo) && ufo > 0) scene.setUfoOdds(ufo)
    return () => {
      scene.dispose()
      sceneRef.current = undefined
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Switching org or timeframe swaps the whole herd; that is a new field, not a migration.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !data) return
    const animate = shownKeyRef.current === key
    shownKeyRef.current = key
    // Closed pull requests burn where they stand; the hand of god is not called.
    if (animate) for (const id of closedIds) scene.burn(id)
    scene.setReleaseMode(releaseMode)
    scene.setCows(specs, animate)
    if (selected && !byId.has(selected)) setSelected(undefined)
    if (process.env.NODE_ENV !== "production") {
      // Dev harness: `__pasture.scene.setCows(specs, true)` from the console plays the hand of god.
      ;(window as unknown as { __pasture?: unknown }).__pasture = { scene, specs }
    }
  }, [specs, data, key, byId, selected, closedIds, releaseMode])
  useEffect(() => sceneRef.current?.select(selected), [selected])
  useEffect(() => sceneRef.current?.setTour(settings.tour), [settings.tour])
  useEffect(() => {
    if (!bubble) return
    let raf = 0
    const follow = () => {
      const at = sceneRef.current?.screenPosition(bubble.id)
      if (at) setBubble((current) => (current && current.id === bubble.id && current.text === bubble.text ? { ...current, x: at.x, y: at.y } : current))
      raf = requestAnimationFrame(follow)
    }
    raf = requestAnimationFrame(follow)
    const timer = setTimeout(() => setBubble(undefined), 4200)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
    }
  }, [bubble?.id, bubble?.text]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => sceneRef.current?.setFilter(focus ? new Set([focus]) : undefined), [focus])
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    scene.setReleaseMode(releaseMode)
    scene.setSign("merged", releaseMode ? "Waiting for release" : `Merged, ${timeframeLabel(settings.days)}`)
    scene.setSign("recent", "Recently released")
  }, [releaseMode, settings.days])
  useEffect(() => sceneRef.current?.setRelease(releaseEvent), [releaseEvent])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      // An open who's who menu takes the Escape for itself.
      if (document.querySelector(".whoswho-menu")) return
      if (selected) setSelected(undefined)
      else if (focus) setFocus(undefined)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [selected, focus])

  const speak = async () => {
    if (mooing || !current) return
    setMooing(true)
    await moo(current.breed.size).catch(() => undefined)
    setMooing(false)
  }

  const update = (patch: Partial<Settings>) => setSettings((current) => ({ ...current, ...patch }))

  const summary = () => {
    if (!data) return loading ? "Rounding up the herd…" : error ? "The field is empty until GitHub answers." : ""
    const parts: string[] = []
    if (releaseFeed) {
      parts.push(`${counts.merged} waiting for release · ${counts.recent} released recently`)
    } else {
      const mergedShown = members.filter((member) => member.kind === "merged").length
      const mergedTotal = data.merged.length
      const more = data.truncatedMerged ? "+" : ""
      parts.push(
        mergedShown < mergedTotal || more
          ? `${mergedShown} of ${mergedTotal}${more} merged ${timeframeLabel(data.days)}`
          : `${mergedTotal} merged ${timeframeLabel(data.days)}`,
      )
    }
    const open = counts.draft + counts.awaiting + counts.changes + counts.ready
    const stages = [
      counts.draft ? plural(counts.draft, "draft") : "",
      counts.awaiting ? `${counts.awaiting} awaiting review` : "",
      counts.changes ? `${counts.changes} changes requested` : "",
      counts.ready ? `${counts.ready} ready` : "",
    ].filter(Boolean)
    parts.push(`${open} open${data.openMode === "active" ? ` (touched ${timeframeLabel(data.days)})` : ""}${stages.length ? `: ${stages.join(" · ")}` : ""}`)
    parts.push(plural(people.length, "person", "people"))
    return parts.join(" · ")
  }

  return (
    <div className="app">
      <header className="topbar">
        <a className="brand" href="/pasture">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/img/cow-side.png" alt="" />
          <h1>Pasture</h1>
        </a>
        <ScopePicker value={settings.scope} viewer={viewer} onChange={(scope) => update({ scope })} />
        <span className="summary" title={summary()}>
          {summary()}
        </span>
        <div className="segmented" role="group" aria-label="Timeframe">
          {PASTURE_TIMEFRAMES.map((frame) => (
            <button key={frame.id} type="button" aria-pressed={settings.days === frame.days} onClick={() => update({ days: frame.days })}>
              {frame.label}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="Which open pull requests">
          <button type="button" aria-pressed={settings.openMode === "active"} onClick={() => update({ openMode: "active" })} title="Open PRs touched inside the timeframe">
            Active
          </button>
          <button type="button" aria-pressed={settings.openMode === "all"} onClick={() => update({ openMode: "all" })} title="Every open PR, however old">
            All open
          </button>
        </div>
        <WhosWho people={people} focus={focus} onFocus={setFocus} />
        <button
          type="button"
          className="textbtn"
          aria-pressed={settings.mooOnMove}
          title={settings.mooOnMove ? "Cows moo when the hand of god picks them up. Click to hush them." : "Silent. Click and every cow moos when it is picked up."}
          onClick={() => update({ mooOnMove: !settings.mooOnMove })}
        >
          {settings.mooOnMove ? "🔔 Moo on move" : "🔕 Moo on move"}
        </button>
        <button
          type="button"
          className="textbtn"
          aria-pressed={settings.tour}
          title={settings.tour ? "The camera drifts around the farm on its own. Click to hold still." : "Click and the camera tours the farm like a screensaver."}
          onClick={() => update({ tour: !settings.tour })}
        >
          🎥 Tour
        </button>
        <button type="button" className={`iconbtn${loading ? " spinning" : ""}`} aria-label="Refresh" title="Refresh" disabled={loading} onClick={() => void load(undefined, true)}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
            <path d="M13.5 2.5v3h-3" />
          </svg>
        </button>
        {props.signOut ? (
          <div className="account">
            {viewer?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img className="avatar" src={viewer.avatarUrl} alt="" referrerPolicy="no-referrer" style={{ boxShadow: "none" }} />
            ) : null}
            <form action={props.signOut}>
              <button type="submit" className="textbtn">
                Sign out
              </button>
            </form>
          </div>
        ) : null}
      </header>

      <div ref={hostRef} className="field">
        <canvas ref={canvasRef} />

        {loading && !data ? <div className="overlay">Rounding up the herd…</div> : null}
        {error ? (
          <div className="notice">
            <span className="pill danger">{error}</span>
          </div>
        ) : null}
        {data && !error && members.length === 0 ? (
          <div className="empty">
            <span className="pill">No pull requests {timeframeLabel(data.days)}. An empty field is still a nice field.</span>
          </div>
        ) : null}

        {hoveredCow && hover && hoveredCow.id !== selected ? (
          <HoverCard member={hoveredCow} collar={collars.get(hoveredCow.author)} avatar={avatars.get(hoveredCow.author) ?? null} x={hover.x} y={hover.y} now={now} scope={settings.scope} />
        ) : null}
        {hoveredCritter && hover ? (
          <div className="hovercard" style={{ left: `${hover.x + 14}px`, top: `${hover.y + 14}px` }}>
            <div className="title">
              {hoveredCritter.name}
              {hoveredCritter.id === FARMER_ID ? " · the farmer" : hoveredCritter.kind === "dog" ? " · dog" : hoveredCritter.kind === "pig" ? " · in the loft" : " · cat"}
            </div>
            <div className="meta">{hoveredCritter.blurb}</div>
          </div>
        ) : null}
        {hoveredWolf && hover ? (
          <div className="hovercard" style={{ left: `${hover.x + 14}px`, top: `${hover.y + 14}px` }}>
            <div className="title">🐺 {hoveredWolf.name}</div>
            <div className="meta">
              alert firing{hoveredWolf.since ? ` since ${relative(hoveredWolf.since, now)}` : ""} · click to open in Datadog
            </div>
          </div>
        ) : null}
        {alerts.count > 0 ? (
          <a
            className="pill wolves"
            href={`https://app.${process.env.NEXT_PUBLIC_DD_SITE || "us5.datadoghq.com"}/monitors/manage?q=status%3Aalert`}
            target="_blank"
            rel="noopener noreferrer"
            title="Wolves on the field: Datadog monitors in alert. Click to see them all."
          >
            🐺 {plural(alerts.count, "alert")} firing
          </a>
        ) : null}
        {releaseEvent ? <ReleaseStatus event={releaseEvent} /> : null}
        {bubble ? (
          <div className="bubble" style={{ left: `${bubble.x}px`, top: `${bubble.y}px` }} role="status">
            {bubble.text}
          </div>
        ) : null}

        {current ? (
          <Inspector
            member={current}
            collar={collars.get(current.author)}
            avatar={avatars.get(current.author) ?? null}
            now={now}
            scope={settings.scope}
            mooing={mooing}
            onMoo={() => void speak()}
            onClose={() => setSelected(undefined)}
          />
        ) : null}

        <div className="hint pill">hover a cow for its PR · click to lift · double-click to open · drag to look around · cows change pens as PRs advance</div>
        {liveSky && ready ? (
          <div className="pill sky" title="The sky over the field is San Francisco's, sun and weather included">
            {SAN_FRANCISCO.name} · {localClock(new Date(now))}
            {weather ? ` · ${describeWeather(weather.code)}${weather.temperatureF !== null ? ` ${Math.round(weather.temperatureF)}°F` : ""}` : ""}
          </div>
        ) : null}
      </div>
    </div>
  )
}
