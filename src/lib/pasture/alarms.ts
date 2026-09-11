import type { Alarm, AlarmSeverity } from "./types"

/**
 * Which firing monitors are wolves. Pure, so it can be tested: the Datadog
 * fetch that feeds it lives in lib/alarms.ts.
 */

export const DEFAULT_NOTIFY = "@webhook-IncidentIO-Oncall-Alerts"
/** Past this many the field is a wolf pack, not a warning. */
export const MAX_WOLVES = 12

/** The parts of `GET /api/v1/monitor` this cares about. */
export type RawMonitor = {
  id: number
  name: string
  message?: string | null
  tags?: string[] | null
  priority?: number | null
  overall_state?: string | null
  options?: { silenced?: Record<string, number | null> | null } | null
  matching_downtimes?: unknown[] | null
  state?: { groups?: Record<string, { status?: string | null; last_triggered_ts?: number | null; name?: string | null }> | null } | null
}

function severity(priority: number | null | undefined): AlarmSeverity {
  return typeof priority === "number" && priority <= 2 ? "critical" : "alert"
}

/**
 * The firing pages among a list of monitors. A monitor that alerts per group
 * ("by {organization_id}") gives one alarm per alerting group; a simple
 * monitor gives one. Muted monitors and ones inside a downtime are skipped.
 */
export function alarmsFromMonitors(monitors: RawMonitor[], notify = DEFAULT_NOTIFY, appHost = "datadoghq.com", now = Date.now()): Alarm[] {
  const needle = notify.toLowerCase()
  const alarms: Alarm[] = []
  for (const monitor of monitors) {
    if (monitor.overall_state !== "Alert") continue
    if (!(monitor.message ?? "").toLowerCase().includes(needle)) continue
    if (monitor.options?.silenced && "*" in monitor.options.silenced) continue
    if (monitor.matching_downtimes?.length) continue
    const team = (monitor.tags ?? []).find((tag) => tag.startsWith("team:"))?.slice(5)
    const base = `https://${appHost}/monitors/${monitor.id}`
    const level = severity(monitor.priority)
    const groups = Object.entries(monitor.state?.groups ?? {}).filter(([, group]) => group?.status === "Alert")
    if (!groups.length) {
      alarms.push({ id: String(monitor.id), monitorId: monitor.id, title: monitor.name, team, severity: level, since: new Date(now).toISOString(), url: base })
      continue
    }
    for (const [key, group] of groups) {
      const name = group.name ?? key
      const since = group.last_triggered_ts ? new Date(group.last_triggered_ts * 1000).toISOString() : new Date(now).toISOString()
      // "*" is a plain metric monitor; "total" is a log monitor with no `by`. Neither is a real group.
      const simple = name === "*" || name === "total"
      alarms.push({
        id: simple ? String(monitor.id) : `${monitor.id}|${name}`,
        monitorId: monitor.id,
        title: monitor.name,
        group: simple ? undefined : name,
        team,
        severity: level,
        since,
        url: simple ? base : `${base}?group=${encodeURIComponent(name)}`,
      })
    }
  }
  // Oldest first, so the pack is stable and the newest wolf is the one that just arrived.
  alarms.sort((a, b) => Date.parse(a.since) - Date.parse(b.since) || a.id.localeCompare(b.id))
  return alarms.slice(0, MAX_WOLVES)
}
