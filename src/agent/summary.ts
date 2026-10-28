// The ride as the model reads it.
//
// PURE, and deliberately TEXT rather than the payload: a ride's leg geometry runs
// to tens of thousands of coordinates and the model needs none of them to reason
// about which town comes after which. Leaving it out is the single biggest lever on
// what a free-tier turn costs, so nothing here may ever print a leg's geometry —
// test/agent-summary.test.ts holds that.
//
// Every route and point is named by its uid, because uids are the only identity
// that survives a save; the tools take them back as arguments.
import type { RidePayload } from '../maps/ride-graph'
import { METERS_PER_MILE } from '../maps/kml'

export type Units = 'mi' | 'km'

// What a straight placeholder leg is assumed to take when the router has not
// answered yet, so an ETA past one is an estimate rather than a blank.
const FALLBACK_MPS = 50 * (METERS_PER_MILE / 3600)

const dist = (m: number, u: Units) =>
  u === 'mi' ? (m / METERS_PER_MILE).toFixed(1) + ' mi' : (m / 1000).toFixed(1) + ' km'

function dur(s: number): string {
  const m = Math.round(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

// Wall clock carried as UTC (see route-clock.js), so it is read back in UTC and
// printed as the digits the rider typed.
function clock(iso: string, plusS: number): string {
  const d = new Date(Date.parse(iso) + plusS * 1000)
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

export function rideSummary(ride: RidePayload, opts: { units?: Units; includeDetails?: boolean } = {}): string {
  const u = opts.units ?? 'mi'
  const groups = new Map(ride.subgroups.map((g) => [g.uid, g.name]))
  const out: string[] = []
  out.push(
    `Ride "${ride.title}": ${ride.routes.length} route${ride.routes.length === 1 ? '' : 's'}, distances in ${u}, positions as (lat, lng).`,
  )
  if (ride.description) out.push(`Description: ${ride.description.slice(0, 500)}`)

  ride.routes.forEach((route, r) => {
    let meters = 0
    let riding = 0
    let estimated = false
    for (const leg of route.legs) {
      meters += leg.distanceM
      if (leg.durationS > 0) riding += leg.durationS
      else {
        riding += leg.distanceM / FALLBACK_MPS
        estimated = true
      }
    }
    const tags: string[] = []
    if (route.altGroup != null)
      tags.push(`alternate group ${route.altGroup}${route.altActive ? ', active' : ', not chosen'}`)
    if (route.subgroupUid && groups.has(route.subgroupUid)) tags.push(`ridden by ${groups.get(route.subgroupUid)}`)
    const departs = route.startAt ? ` departs ${clock(route.startAt, 0)}` : ' (no departure time)'
    out.push('')
    out.push(
      `Route ${r + 1} [${route.uid}] "${route.title || 'Untitled'}"${departs} · ${dist(meters, u)} · ${dur(riding)} riding${estimated ? ' (part estimated)' : ''}${tags.length ? ' · ' + tags.join('; ') : ''}`,
    )

    let at = 0
    let t = 0
    route.points.forEach((p, i) => {
      const kind = p.kind === 'stop' ? 'STOP' : 'poi'
      const roles = p.roles.length ? ' ' + p.roles.join(',') : ''
      const eta = route.startAt ? ` ETA ${clock(route.startAt, t)}` : ''
      const dwell = p.durationMin ? ` dwell ${p.durationMin}m` : ''
      const addr = p.address ? `, ${p.address}` : ''
      out.push(
        `  ${i}. [${p.uid}] ${kind}${roles} "${p.name || 'Unnamed'}"${addr} (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}) at ${dist(at, u)}${eta}${dwell}`,
      )
      if (p.description) out.push(`     note: ${p.description.slice(0, 300)}`)
      if (opts.includeDetails && p.details?.notes) out.push(`     private note: ${p.details.notes.slice(0, 300)}`)
      const leg = route.legs[i]
      if (leg) {
        at += leg.distanceM
        // The dwell AT a point is spent before leaving it, except at the start,
        // where the departure time is the moment the group sets off.
        if (i > 0 && p.durationMin) t += p.durationMin * 60
        t += leg.durationS > 0 ? leg.durationS : leg.distanceM / FALLBACK_MPS
      }
    })
  })
  return out.join('\n')
}
