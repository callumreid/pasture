import { describe, expect, test } from "vitest"
import { alarmsFromMonitors, type RawMonitor } from "./alarms"

const NOW = Date.parse("2026-09-11T17:00:00Z")
const HOST = "us5.datadoghq.com"

const paging = (extra: Partial<RawMonitor> = {}): RawMonitor => ({
  id: 22370945,
  name: "Uploaded Conversations results are not retrievable",
  message: "Five conversations lost.\n{{#is_alert}} @slack-alert-engineering @webhook-IncidentIO-Oncall-Alerts {{/is_alert}}",
  tags: ["env:prod", "team:backend"],
  priority: 2,
  overall_state: "Alert",
  state: { groups: { "*": { status: "Alert", last_triggered_ts: 1789144445, name: "*" } } },
  ...extra,
})

describe("alarms from monitors", () => {
  test("a firing monitor that pages is one wolf", () => {
    const [alarm, ...rest] = alarmsFromMonitors([paging()], undefined, HOST, NOW)
    expect(rest).toHaveLength(0)
    expect(alarm).toMatchObject({ id: "22370945", monitorId: 22370945, team: "backend", severity: "critical", group: undefined })
    expect(alarm.url).toBe("https://us5.datadoghq.com/monitors/22370945")
    expect(alarm.since).toBe("2026-09-11T16:34:05.000Z")
  })

  test("a log monitor's lone 'total' group is not a group", () => {
    const monitor = paging({ state: { groups: { total: { status: "Alert", last_triggered_ts: 1789144445, name: "total" } } } })
    const [alarm] = alarmsFromMonitors([monitor], undefined, HOST, NOW)
    expect(alarm).toMatchObject({ id: "22370945", group: undefined, url: "https://us5.datadoghq.com/monitors/22370945" })
  })

  test("slack-only and shadow monitors stay off the field even while alerting", () => {
    const slackOnly = paging({ id: 1, message: "@slack-alert-engineering" })
    const shadow = paging({ id: 2, message: "This monitor is silent." })
    expect(alarmsFromMonitors([slackOnly, shadow], undefined, HOST, NOW)).toEqual([])
  })

  test("a monitor that is not alerting is not a wolf, whatever it notifies", () => {
    expect(alarmsFromMonitors([paging({ overall_state: "OK" }), paging({ overall_state: "Warn" })], undefined, HOST, NOW)).toEqual([])
  })

  test("muted monitors and ones inside a downtime are skipped", () => {
    expect(alarmsFromMonitors([paging({ options: { silenced: { "*": null } } })], undefined, HOST, NOW)).toEqual([])
    expect(alarmsFromMonitors([paging({ matching_downtimes: [{}] })], undefined, HOST, NOW)).toEqual([])
  })

  test("a multi-alert monitor gives one wolf per alerting group, oldest first", () => {
    const monitor = paging({
      id: 19206844,
      priority: null,
      state: {
        groups: {
          "organization_id:09a81583": { status: "Alert", last_triggered_ts: 1789140000, name: "organization_id:09a81583" },
          "organization_id:2b35844d": { status: "OK", last_triggered_ts: 1789130000, name: "organization_id:2b35844d" },
          "organization_id:194336a3": { status: "Alert", last_triggered_ts: 1789120000, name: "organization_id:194336a3" },
        },
      },
    })
    const alarms = alarmsFromMonitors([monitor], undefined, HOST, NOW)
    expect(alarms.map((alarm) => alarm.id)).toEqual(["19206844|organization_id:194336a3", "19206844|organization_id:09a81583"])
    expect(alarms[0]).toMatchObject({ group: "organization_id:194336a3", severity: "alert" })
    expect(alarms[0].url).toBe("https://us5.datadoghq.com/monitors/19206844?group=organization_id%3A194336a3")
  })

  test("the notify handle is configurable and case-insensitive", () => {
    const monitor = paging({ message: "@PAGERDUTY-Primary" })
    expect(alarmsFromMonitors([monitor], "@pagerduty-primary", HOST, NOW)).toHaveLength(1)
    expect(alarmsFromMonitors([monitor], undefined, HOST, NOW)).toHaveLength(0)
  })

  test("the pack is capped", () => {
    const monitors = Array.from({ length: 20 }, (_, i) => paging({ id: i + 1 }))
    expect(alarmsFromMonitors(monitors, undefined, HOST, NOW)).toHaveLength(12)
  })
})
