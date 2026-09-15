import type { ReleaseEvent } from "@/lib/pasture/releases"

const PHASE_LABEL: Record<ReleaseEvent["phase"], string> = {
  scheduled: "The release window is open",
  queued: "Release queued",
  testing: "Release tests are running",
  deploying: "Going to production",
  verifying: "Verifying production",
  succeeded: "Production is clear",
  failed: "Release needs attention",
}

function Contents({ event }: { event: ReleaseEvent }) {
  return (
    <>
      <span className="release-orb" aria-hidden="true" />
      <span className="release-copy">
        <strong>{PHASE_LABEL[event.phase]}</strong>
        <span>
          {event.label} · {event.environment}
          {event.summary ? ` · ${event.summary}` : ""}
        </span>
      </span>
      {event.url ? <span aria-hidden="true">↗</span> : null}
    </>
  )
}

export function ReleaseStatus({ event }: { event: ReleaseEvent }) {
  const className = `release-status release-${event.phase}`
  return event.url ? (
    <a className={className} href={event.url} target="_blank" rel="noopener noreferrer" role="status">
      <Contents event={event} />
    </a>
  ) : (
    <div className={className} role="status">
      <Contents event={event} />
    </div>
  )
}
