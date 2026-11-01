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
import { METERS_PER_MILE, type Track } from '../maps/kml'
import { describePrefs } from '../maps/route-prefs'
import { twistiness, twistLabel } from '../maps/twist'
import { toPower, toVehicle, type Power, type Vehicle } from '../views/vocab'

export type Units = 'mi' | 'km'

// What a straight placeholder leg is assumed to take when the router has not
// answered yet: NOMINAL_SPEED_MS in public/js/ride-time.js, the builder's own
// figure, so the assistant and the builder print the same estimated time (#444).
// test/agent-summary.test.ts pins the two and checks every ETA against that file.
export const FALLBACK_MPS = 20

/** A leg the router never answered for: distance but no riding time. The same
 *  test as ride-time.js's legIsEstimated(). */
const estimated = (leg: { distanceM: number; durationS: number }) => leg.durationS <= 0 && leg.distanceM > 0
const legS = (leg: { distanceM: number; durationS: number }) =>
  estimated(leg) ? Math.round(leg.distanceM / FALLBACK_MPS) : leg.durationS

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

/** Which version of the ride a summary describes: the builder's open copy, or what
 *  is saved at a revision plus any changes proposed on top of it over MCP. */
export type Snapshot = { kind: 'draft' } | { kind: 'saved'; rev: number; pending: number }

function snapshotLine(s: Snapshot): string {
  if (s.kind === 'draft') return 'This is the builder’s open copy, unsaved edits included.'
  if (s.pending === 0) return `As saved (revision ${s.rev}).`
  return `As saved (revision ${s.rev}) plus ${s.pending} change${s.pending === 1 ? '' : 's'} you proposed that ${s.pending === 1 ? 'is' : 'are'} not applied yet.`
}

/** The vehicle and power the ride is planned for: the ride's own setting, or the
 *  rider's default where the ride sets none, which is how the builder reads it. */
export type Preset = { vehicle: Vehicle; power: Power; vehicleFromRide: boolean; powerFromRide: boolean }

/** The ride's own vehicle and power where it sets them, else the rider's default,
 *  coerced the way the settings page coerces a pair (a bicycle does not run on gas). */
export function presetOf(
  ride: { vehicle: string | null; power: string | null },
  rider: { vehicle?: string | null; power?: string | null } | null,
): Preset {
  const vehicle = toVehicle(ride.vehicle ?? rider?.vehicle)
  return {
    vehicle,
    power: toPower(ride.power ?? rider?.power, vehicle),
    vehicleFromRide: ride.vehicle != null,
    powerFromRide: ride.power != null,
  }
}

function presetLine(p: Preset): string {
  const what = `${p.vehicle} on ${p.power === 'pedal' ? 'pedal power' : p.power === 'electric' ? 'electricity' : 'gas'}`
  // Resolved field by field, so said field by field: a ride can set the vehicle and
  // leave the power to the rider.
  const whose =
    p.vehicleFromRide && p.powerFromRide
      ? 'set on this ride'
      : p.vehicleFromRide
        ? 'vehicle set on this ride, power from the rider’s default'
        : p.powerFromRide
          ? 'power set on this ride, vehicle from the rider’s default'
          : 'the rider’s default; the ride sets neither'
  const fuel = p.power === 'pedal' ? ' No fuel planning applies: plan water and food instead.' : ''
  return `Planned for a ${what} (${whose}).${fuel}`
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

export function rideSummary(
  ride: RidePayload,
  opts: { units?: Units; includeDetails?: boolean; snapshot?: Snapshot; preset?: Preset } = {},
): string {
  const u = opts.units ?? 'mi'
  const groups = new Map(ride.subgroups.map((g) => [g.uid, g.name]))
  const out: string[] = []
  out.push(
    `Ride "${ride.title}": ${ride.routes.length} route${ride.routes.length === 1 ? '' : 's'}, distances in ${u}, positions as (lat, lng).`,
  )
  if (opts.snapshot) out.push(snapshotLine(opts.snapshot))
  if (opts.preset) out.push(presetLine(opts.preset))
  if (ride.stopByMin != null)
    out.push(`Stop-by time: the group wants to be looking for a bed by ${hhmm(ride.stopByMin)}, local time.`)
  if (ride.description) out.push(`Description: ${ride.description.slice(0, 500)}`)

  ride.routes.forEach((route, r) => {
    let meters = 0
    let riding = 0
    const undrawn = route.legs.filter(estimated).length
    for (const leg of route.legs) {
      meters += leg.distanceM
      riding += legS(leg)
    }
    const tags: string[] = []
    if (route.altGroup != null)
      tags.push(`alternate group ${route.altGroup}${route.altActive ? ', active' : ', not chosen'}`)
    if (route.subgroupUid && groups.has(route.subgroupUid)) tags.push(`ridden by ${groups.get(route.subgroupUid)}`)
    const departs = route.startAt ? ` departs ${clock(route.startAt, 0)}` : ' (no departure time)'
    out.push('')
    out.push(
      `Route ${r + 1} [${route.uid}] "${route.title || 'Untitled'}"${departs} · ${dist(meters, u)} · ${dur(riding)} riding${undrawn ? ` (part estimated: ${undrawn} leg${undrawn === 1 ? '' : 's'} not drawn yet)` : ''}${tags.length ? ' · ' + tags.join('; ') : ''}`,
    )
    // ONE LINE OF CHARACTER ON EVERY ROUTE, never the geometry it is computed from.
    // Twistiness only when every leg is drawn: a straight placeholder would read as a
    // straight road, so an undrawn route says it cannot tell yet.
    const character: string[] = [describePrefs(route.routePrefs) || 'no routing preferences']
    const label = undrawn ? null : twistLabel(twistiness(route.legs.flatMap((l) => l.geometry) as Track)?.dpm)
    character.push(
      label ? `twistiness: ${label}` : undrawn ? 'twistiness unknown until every leg is drawn' : 'twistiness unknown',
    )
    out.push(`  ${character.join(' · ')}`)

    // THE SAME WALK AS elapsedToPointS() in ride-time.js: arriving at a point is the
    // dwell of every point before it, the first included, plus every leg before it.
    // Anything past an undrawn leg is a guess, and says so.
    let at = 0
    let t = 0
    let guess = false
    route.points.forEach((p, i) => {
      const kind = p.kind === 'stop' ? 'STOP' : 'poi'
      const roles = p.roles.length ? ' ' + p.roles.join(',') : ''
      const est = guess ? ' (est.)' : ''
      const eta = route.startAt ? ` ETA ${clock(route.startAt, t)}${est}` : ''
      const dwell = p.durationMin ? ` dwell ${p.durationMin}m` : ''
      const addr = p.address ? `, ${p.address}` : ''
      out.push(
        `  ${i}. [${p.uid}] ${kind}${roles} "${p.name || 'Unnamed'}"${addr} (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}) at ${dist(at, u)}${est}${eta}${dwell}`,
      )
      if (p.description) out.push(`     note: ${p.description.slice(0, 300)}`)
      if (opts.includeDetails && p.details?.notes) out.push(`     private note: ${p.details.notes.slice(0, 300)}`)
      const leg = route.legs[i]
      if (leg) {
        at += leg.distanceM
        t += (p.durationMin ?? 0) * 60 + legS(leg)
        if (estimated(leg)) guess = true
      }
    })
  })
  return out.join('\n')
}
