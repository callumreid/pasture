import "server-only"
import { DEFAULT_NOTIFY, alarmsFromMonitors, type RawMonitor } from "@/lib/pasture/alarms"
import type { Alarm } from "@/lib/pasture/types"

/**
 * Where the wolves come from: Datadog monitors that are alerting AND page
 * someone. A monitor pages when its message notifies the on-call webhook;
 * everything that only posts to Slack, and every silent "shadow" monitor,
 * stays off the field.
 *
 *   DD_API_KEY, DD_APP_KEY   an application key with `monitors_read`
 *   DD_SITE                  e.g. us5.datadoghq.com (default datadoghq.com)
 *   PASTURE_ALARM_NOTIFY     the notification handle that means "this pages";
 *                            default @webhook-IncidentIO-Oncall-Alerts
 *   PASTURE_ALARMS=fake      local development: a wolf or two on a timer
 */

export function alarmsConfigured() {
  return process.env.PASTURE_ALARMS === "fake" || (!!process.env.DD_API_KEY && !!process.env.DD_APP_KEY)
}

export class AlarmError extends Error {
  status: number
  constructor(message: string, status = 502) {
    super(message)
    this.status = status
  }
}

const site = () => process.env.DD_SITE || "datadoghq.com"

async function fetchDatadog(): Promise<Alarm[]> {
  const apiKey = process.env.DD_API_KEY
  const appKey = process.env.DD_APP_KEY
  if (!apiKey || !appKey) return []
  const url = `https://api.${site()}/api/v1/monitor?group_states=alert&page_size=1000`
  const response = await fetch(url, {
    headers: { "DD-API-KEY": apiKey, "DD-APPLICATION-KEY": appKey, accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  })
  if (response.status === 403 || response.status === 401) throw new AlarmError("Datadog rejected the alarm keys", 502)
  if (response.status === 429) throw new AlarmError("Datadog is rate-limiting the alarm keys", 502)
  if (!response.ok) throw new AlarmError(`Datadog ${response.status}: ${response.statusText}`)
  const monitors = (await response.json()) as RawMonitor[]
  if (!Array.isArray(monitors)) throw new AlarmError("Datadog returned something that is not a monitor list")
  return alarmsFromMonitors(monitors, process.env.PASTURE_ALARM_NOTIFY || DEFAULT_NOTIFY, site())
}

// ---------------------------------------------------------------- fake

/** Two pretend pages on a loop: one is up four minutes in every six, the other two in every nine. */
function fakeAlarms(now = Date.now()): Alarm[] {
  const alarms: Alarm[] = []
  const minute = 60_000
  const a = Math.floor(now / (6 * minute))
  if (now % (6 * minute) < 4 * minute)
    alarms.push({ id: "fake-1", monitorId: 1, title: "Uploaded Conversations results are not retrievable", team: "backend", severity: "critical", since: new Date(a * 6 * minute).toISOString(), url: "https://app.datadoghq.com/monitors/1" })
  const b = Math.floor(now / (9 * minute))
  if (now % (9 * minute) < 2 * minute)
    alarms.push({ id: "fake-2|organization_id:09a81583", monitorId: 2, title: "P95 Simulation queue time is too long for high-priority customers", group: "organization_id:09a81583", team: "backend", severity: "alert", since: new Date(b * 9 * minute).toISOString(), url: "https://app.datadoghq.com/monitors/2" })
  return alarms
}

/** Every page that is firing right now. Empty when no source is configured. */
export function fetchAlarms(): Promise<Alarm[]> {
  if (process.env.PASTURE_ALARMS === "fake") return Promise.resolve(fakeAlarms())
  return fetchDatadog()
}
