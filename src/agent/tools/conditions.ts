// `get_conditions`: the forecast, the terrain, and the daylight along one route,
// matched to when the group actually reaches each spot.
//
// FROM THE RIDE THE ASSISTANT HOLDS, NEVER A DATABASE READ: the builder's open copy
// or the MCP's saved one is `ctx.ride`, and its legs are what is sampled. A stored
// route would answer about a road the rider may have just changed.
//
// EMPTY NEVER MEANS CLEAR. A route with no departure, a date in the past or beyond
// the forecast, or a service that did not answer is each said in words, so the model
// cannot read silence as fair weather.
//
// One route per call, through src/maps/conditions.ts with its samples THINNED to the
// hard caps (`thin: true`), so a route of four hundred short legs asks for twelve
// forecasts and eighty heights like any other: Open-Meteo is free and keyless, so
// nothing here touches the Google budget, but its free tier is a budget of its own.
//
// EVERY CLOCK IS CONVERTED THROUGH OPEN-METEO'S OFFSETS. A forecast's hours and a
// sunset are local to the spot asked about, while the route's clock is the departure
// point's; each forecast carries `utcOffsetS`, so a spot over a zone line (or a DST
// change) is read at its own local hour, and the arrival is compared with sunset on
// the end point's clock. With no offset to hand the two are compared digit for digit.
import { z } from 'zod'
import type { RoutePayload } from '../../maps/ride-graph'
import { METERS_PER_MILE, type Track } from '../../maps/kml'
import {
  FORECAST_DAYS,
  forecastWindow,
  routeElevation,
  routeWeather,
  sunTimes,
  weatherSamples,
  type ElevationPoint,
  type SunTimes,
  type WeatherPoint,
} from '../../maps/conditions'
import { cite } from '../provenance'
import { FALLBACK_MPS, type Snapshot, type Units } from '../summary'
import type { AgentContext, Tool } from '../tools'

const tool = <S extends z.ZodObject>(t: Tool<S>) => t

type Leg = RoutePayload['legs'][number]

// --- The route's own clock ---------------------------------------------------

/** A leg's riding time, with an undrawn leg at the builder's nominal speed: the
 *  same rule as summary.ts and ride-time.js. */
const legSeconds = (leg: Leg) =>
  leg.durationS <= 0 && leg.distanceM > 0 ? Math.round(leg.distanceM / FALLBACK_MPS) : leg.durationS

/**
 * Seconds from departure to leaving each point, and to the final arrival. Arriving
 * at a point is every dwell before it plus every leg before it, the walk summary.ts
 * and elapsedToPointS() make. Pure.
 */
export function routeClock(route: RoutePayload): { leave: number[]; endS: number } {
  const leave: number[] = []
  let t = 0
  route.points.forEach((p, i) => {
    t += (p.durationMin ?? 0) * 60
    leave.push(t)
    const leg = route.legs[i]
    if (leg && i < route.points.length - 1) t += legSeconds(leg)
  })
  // The arrival at the last point, before any dwell there.
  const last = route.points.length - 1
  const endS = last >= 0 ? leave[last] - (route.points[last].durationMin ?? 0) * 60 : 0
  return { leave, endS }
}

/** Seconds from departure to a spot `f` of the way along leg `leg`. */
const secondsAt = (route: RoutePayload, leave: number[], leg: number, f: number) =>
  (leave[leg] ?? 0) + f * (route.legs[leg] ? legSeconds(route.legs[leg]) : 0)

/** A wall clock at the departure point, carried as UTC (see route-clock.js), so it
 *  is read back in UTC: `YYYY-MM-DDTHH:MM`. */
const wall = (startAt: string, s: number) => new Date(Date.parse(startAt) + s * 1000).toISOString().slice(0, 16)

/** Seconds a spot's local clock runs ahead of the departure clock, from Open-Meteo's
 *  offsets; zero when either is unknown, which is the digit-for-digit reading. Pure. */
export const clockShift = (dep: number | null | undefined, there: number | null | undefined) =>
  dep != null && there != null ? there - dep : 0

/** The departure point's offset: the first forecast sample's, the one nearest the start. */
export const departureOffset = (weather: WeatherPoint[] | null) => weather?.[0]?.utcOffsetS ?? null

/** When the route ends on its own clock, as an ISO date-time, or null when undated. */
export function routeEndIso(route: RoutePayload): string | null {
  if (!route.startAt) return null
  return new Date(Date.parse(route.startAt) + routeClock(route).endS * 1000).toISOString()
}

// --- Units -------------------------------------------------------------------

const toF = (c: number) => (c * 9) / 5 + 32
const temp = (c: number, u: Units) => (u === 'mi' ? `${Math.round(toF(c))}°F` : `${Math.round(c)}°C`)
const speed = (kmh: number, u: Units) => (u === 'mi' ? `${Math.round(kmh / 1.609344)} mph` : `${Math.round(kmh)} km/h`)
const height = (m: number, u: Units) =>
  u === 'mi' ? `${Math.round(m * 3.28084).toLocaleString('en-US')} ft` : `${Math.round(m).toLocaleString('en-US')} m`
const dist = (m: number, u: Units) =>
  u === 'mi' ? `${(m / METERS_PER_MILE).toFixed(1)} mi` : `${(m / 1000).toFixed(1)} km`

/** Where a spot is, in the rider's terms: at a point, or between two, and how far in. */
function place(route: RoutePayload, leg: number, f: number, u: Units): string {
  const name = (i: number) => `“${route.points[i]?.name || 'Unnamed'}”`
  let m = 0
  for (let i = 0; i < leg; i++) m += route.legs[i]?.distanceM ?? 0
  m += f * (route.legs[leg]?.distanceM ?? 0)
  const where =
    f <= 0.02 ? `at ${name(leg)}` : f >= 0.98 ? `at ${name(leg + 1)}` : `between ${name(leg)} and ${name(leg + 1)}`
  return `${where} (${dist(m, u)} in)`
}

const hhmm = (wallIso: string) => wallIso.slice(11, 16)

// --- Ziad's cold bands -------------------------------------------------------

export type ColdBand = 'freezing' | '30s' | '40s' | '50s'

/** The owner's motorcycle bands, on °F whatever the rider reads in. Pure. */
export function coldBand(tempC: number): ColdBand | null {
  const f = toF(tempC)
  if (f < 32) return 'freezing'
  if (f < 40) return '30s'
  if (f < 50) return '40s'
  if (f < 60) return '50s'
  return null
}

const BAND_TEXT: Record<ColdBand, string> = {
  freezing: 'below freezing: not a riding day on a motorcycle',
  '30s': 'in the 30s °F: bearable only for short periods',
  '40s': 'in the 40s °F: very cold',
  '50s': 'in the 50s °F: brisk',
}

// Weather codes worth naming on their own: ice and snow end a motorcycle's day, and
// a thunderstorm is waited out.
const SNOW = new Set([71, 73, 75, 77, 85, 86])
const ICE = new Set([56, 57, 66, 67])
const THUNDER = new Set([95, 96, 99])

// --- What the tool reads -----------------------------------------------------

export type Reading = {
  leg: number
  f: number
  /** Seconds from departure. */
  s: number
  /** Wall clock at the departure point when the group gets there. */
  eta: string
  /** Local wall clock at the spot itself when the group gets there. */
  local: string
  tempC: number | null
  rainPct: number | null
  windKmh: number | null
  code: number | null
}

/**
 * Each forecast sample at the hour the group reaches it (the nearest hour, on the
 * spot's own clock), and how many samples had no forecast for that hour. Pure.
 */
export function alignReadings(route: RoutePayload, weather: WeatherPoint[]): { readings: Reading[]; missing: number } {
  if (!route.startAt) return { readings: [], missing: weather.length }
  const { leave } = routeClock(route)
  const t0 = Date.parse(route.startAt)
  const dep = departureOffset(weather)
  const readings: Reading[] = []
  let missing = 0
  for (const w of weather) {
    const s = secondsAt(route, leave, w.leg, w.f)
    const local = s + clockShift(dep, w.utcOffsetS)
    const hour = new Date(Math.round((t0 + local * 1000) / 3_600_000) * 3_600_000).toISOString().slice(0, 13) + ':00'
    const i = w.time.indexOf(hour)
    if (i < 0) {
      missing++
      continue
    }
    readings.push({
      leg: w.leg,
      f: w.f,
      s,
      eta: wall(route.startAt, s),
      local: wall(route.startAt, local),
      tempC: w.tempC[i] ?? null,
      rainPct: w.rainPct[i] ?? null,
      windKmh: w.windKmh[i] ?? null,
      code: w.code[i] ?? null,
    })
  }
  return { readings, missing }
}

/** Why there is no forecast, when there is none to fetch. */
export type ForecastGap = 'no-departure' | 'past' | 'beyond' | null

/** Whether a route can have a forecast at all, by its dates alone. Pure. */
export function forecastGap(startIso: string | null, endIso: string | null, now: Date): ForecastGap {
  if (!startIso) return 'no-departure'
  if (forecastWindow(startIso, endIso, now)) return null
  const today = now.toISOString().slice(0, 10)
  return (endIso ?? startIso).slice(0, 10) < today ? 'past' : 'beyond'
}

export type ConditionsInput = {
  route: RoutePayload
  routeNo: number
  units: Units
  snapshot: Snapshot
  vehicle?: string
  now: Date
  gap: ForecastGap
  /** Null when the service was asked and gave nothing back. */
  weather: WeatherPoint[] | null
  /** How many spots were asked for, to tell a partial answer from a whole one. */
  weatherAsked: number
  elevation: { points: ElevationPoint[]; complete: boolean }
  sun: SunTimes | null
}

const stamp = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'

/** The whole answer, as the model reads it. Pure. */
export function formatConditions(x: ConditionsInput): string {
  const { route, units: u } = x
  const out: string[] = []
  const title = route.title || `route ${x.routeNo}`
  out.push(
    `Conditions for route ${x.routeNo} [${route.uid}] “${title}”${route.startAt ? `, departing ${wall(route.startAt, 0).replace('T', ' ')} (clock at the departure point)` : ''}.`,
  )
  out.push(
    x.snapshot.kind === 'draft'
      ? 'From the builder’s open copy, unsaved edits included.'
      : `From the ride as saved (revision ${x.snapshot.rev})${x.snapshot.pending ? ` plus ${x.snapshot.pending} proposed change${x.snapshot.pending === 1 ? '' : 's'}` : ''}.`,
  )
  const undrawn = route.legs.filter((l) => l.durationS <= 0 && l.distanceM > 0).length
  if (undrawn)
    out.push(
      `${undrawn} leg${undrawn === 1 ? ' is' : 's are'} not drawn yet: there the samples follow a straight line and the times are estimated.`,
    )
  const forecast = cite({ kind: 'forecast', source: 'Open-Meteo', checkedAt: stamp(x.now) })

  // Weather.
  if (x.gap === 'no-departure') {
    out.push(
      'Weather: UNKNOWN. This route has no departure time, and the forecast is matched to when the group reaches each spot. No forecast is not a clear forecast; set a departure to get one.',
    )
  } else if (x.gap === 'past') {
    out.push(`Weather: none. This route’s date (${route.startAt!.slice(0, 10)}) has passed.`)
  } else if (x.gap === 'beyond') {
    out.push(
      `Weather: UNKNOWN. This route rides on ${route.startAt!.slice(0, 10)}, more than ${FORECAST_DAYS} days out, past the end of Open-Meteo’s forecast. That is not a clear forecast; check again closer to the date.`,
    )
  } else if (!x.weather || x.weather.length === 0) {
    out.push(
      x.weatherAsked === 0
        ? 'Weather: UNKNOWN. This route has no road to sample.'
        : 'Weather: UNKNOWN. Open-Meteo did not answer just now. No answer is not a clear forecast; try again in a minute.',
    )
  } else {
    const { readings, missing } = alignReadings(route, x.weather)
    const short = x.weatherAsked - x.weather.length + missing
    out.push(
      `Times below are when the group reaches each spot, on the departure point’s clock unless marked local, from the route’s own schedule ${cite({ kind: 'computed', source: 'Routeloop' })}; forecasts are reused for up to 30 minutes.`,
    )
    if (readings.length === 0) {
      out.push(
        'Weather: UNKNOWN. Open-Meteo had no forecast for the hours the group is on this road. That is not a clear forecast.',
      )
    } else {
      out.push(...weatherLines(x, readings, forecast))
      if (short > 0)
        out.push(
          `Only ${x.weatherAsked - short} of ${x.weatherAsked} spots along the route had a forecast for the hour the group gets there; the rest are unknown, not clear.`,
        )
    }
  }

  // Elevation.
  const ele = x.elevation.points
  if (ele.length === 0) {
    out.push('Elevation: UNKNOWN. Open-Meteo’s terrain data did not answer, or the route has no road to sample.')
  } else {
    const lo = ele.reduce((a, b) => (b.e < a.e ? b : a))
    const hi = ele.reduce((a, b) => (b.e > a.e ? b : a))
    out.push(
      `Elevation: low ${height(lo.e, u)} ${place(route, lo.leg, lo.f, u)}, high ${height(hi.e, u)} ${place(route, hi.leg, hi.f, u)} ${cite({ kind: 'computed', source: 'Routeloop' })}, from Open-Meteo terrain data${x.elevation.complete ? '' : '; partial, some spots did not answer'}.`,
    )
  }

  // Sunrise and sunset at the end of the route, on the date it ends.
  const endIso = routeEndIso(route)
  const last = route.points[route.points.length - 1]
  if (!endIso) {
    out.push('Sunrise and sunset: unknown without a departure date.')
  } else if (!x.sun) {
    out.push(
      `Sunrise and sunset at “${last?.name || 'the end'}” on ${endIso.slice(0, 10)}: unavailable (outside the forecast range, or Open-Meteo did not answer).`,
    )
  } else {
    // Both sides on the end point's own clock, so a zone line cannot flip the verdict.
    const toEnd = clockShift(departureOffset(x.weather), x.sun.utcOffsetS)
    const arrive = wall(route.startAt!, routeClock(route).endS + toEnd)
    const parts = [
      `Sun at “${last?.name || 'the end'}” on ${endIso.slice(0, 10)}: sunrise ${x.sun.sunrise ? hhmm(x.sun.sunrise) : 'unknown'}, sunset ${x.sun.sunset ? hhmm(x.sun.sunset) : 'unknown'}, local time there ${forecast}.`,
    ]
    if (x.sun.sunset && arrive > x.sun.sunset)
      parts.push(
        `The route arrives at ${toEnd ? `${hhmm(arrive)} local time there (${hhmm(endIso)} on the departure clock)` : `${hhmm(arrive)} (departure clock)`}, AFTER SUNSET ${cite({ kind: 'computed', source: 'Routeloop' })}.`,
      )
    out.push(parts.join(' '))
  }
  return out.join('\n')
}

function weatherLines(x: ConditionsInput, readings: Reading[], forecast: string): string[] {
  const { route, units: u } = x
  const when = (r: Reading) =>
    r.local === r.eta ? hhmm(r.eta) : `${hhmm(r.local)} local (${hhmm(r.eta)} departure clock)`
  const at = (r: Reading) => `around ${when(r)} ${place(route, r.leg, r.f, u)}`
  const out: string[] = []

  const temps = readings.filter((r) => r.tempC != null)
  if (temps.length === 0) {
    out.push('Temperature: UNKNOWN for this route’s hours.')
  } else {
    const lo = temps.reduce((a, b) => (b.tempC! < a.tempC! ? b : a))
    const hi = temps.reduce((a, b) => (b.tempC! > a.tempC! ? b : a))
    out.push(`Temperature: low ${temp(lo.tempC!, u)} ${at(lo)}; high ${temp(hi.tempC!, u)} ${at(hi)} ${forecast}.`)
    const band = coldBand(lo.tempC!)
    if (band) {
      const note =
        x.vehicle && x.vehicle !== 'motorcycle'
          ? ` (these are the motorcycle bands; this ride is planned for a ${x.vehicle})`
          : ''
      out.push(`  ${band === 'freezing' ? 'HARD WARNING' : 'Cold'}: the coldest stretch is ${BAND_TEXT[band]}${note}.`)
      // Into the evening as it cools: a 30s reading at four or later there, or after
      // sunset, read on the end point's clock because that is where sunset was asked.
      const sunset = x.sun?.sunset ?? null
      const toEnd = clockShift(departureOffset(x.weather), x.sun?.utcOffsetS)
      const evening = temps.find((r) => {
        const b = coldBand(r.tempC!)
        if (b !== '30s' && b !== 'freezing') return false
        return Number(r.local.slice(11, 13)) >= 16 || (sunset != null && wall(route.startAt!, r.s + toEnd) > sunset)
      })
      if (evening)
        out.push(
          `  HARD WARNING: the route runs into the evening as it cools, ${temp(evening.tempC!, u)} ${at(evening)}. Riding on into the evening in the 30s is debilitating; move the departure earlier or end the day sooner.`,
        )
    }
  }

  const rain = readings.filter((r) => r.rainPct != null)
  if (rain.length === 0) out.push('Rain: chance UNKNOWN for this route’s hours.')
  else {
    const worst = rain.reduce((a, b) => (b.rainPct! > a.rainPct! ? b : a))
    out.push(`Rain: worst chance ${Math.round(worst.rainPct!)}% ${at(worst)} ${forecast}.`)
  }

  const wind = readings.filter((r) => r.windKmh != null)
  if (wind.length === 0) out.push('Wind: UNKNOWN for this route’s hours.')
  else {
    const worst = wind.reduce((a, b) => (b.windKmh! > a.windKmh! ? b : a))
    out.push(`Wind: strongest ${speed(worst.windKmh!, u)} sustained ${at(worst)} ${forecast}.`)
  }

  const severe = readings.filter((r) => r.code != null && (SNOW.has(r.code) || ICE.has(r.code) || THUNDER.has(r.code)))
  for (const r of severe.slice(0, 3)) {
    const what = SNOW.has(r.code!) ? 'snow' : ICE.has(r.code!) ? 'freezing rain or drizzle (ice)' : 'thunderstorms'
    const bike = THUNDER.has(r.code!) ? '' : '; on snow or ice a motorcycle does not go'
    out.push(`  WARNING: ${what} forecast ${at(r)} ${forecast}${bike}.`)
  }
  return out
}

/** Gathers everything for one route and formats it. `now` is injectable for tests. */
export async function conditionsFor(ctx: AgentContext, routeUid: string, now = new Date()): Promise<string> {
  const r = ctx.ride.routes.findIndex((x) => x.uid === routeUid)
  if (r < 0) return `No route with uid ${routeUid}.`
  const route = ctx.ride.routes[r]
  const legs = route.legs.map((l) => l.geometry as Track)
  const endIso = routeEndIso(route)
  const gap = forecastGap(route.startAt, endIso, now)
  const thin = { thin: true }
  const weatherAsked = weatherSamples(legs, thin).length
  ctx.progress(`Checking conditions on ${route.title || `route ${r + 1}`}`)
  const last = route.points[route.points.length - 1]
  const [weather, elevation, sun] = await Promise.all([
    gap == null && weatherAsked > 0 ? routeWeather(legs, route.startAt, endIso, now, thin) : Promise.resolve(null),
    routeElevation(legs, thin),
    endIso && last ? sunTimes([last.lng, last.lat], endIso.slice(0, 10), now) : Promise.resolve(null),
  ])
  return formatConditions({
    route,
    routeNo: r + 1,
    units: ctx.units,
    snapshot: ctx.snapshot,
    vehicle: ctx.preset?.vehicle,
    now,
    gap,
    weather,
    weatherAsked,
    elevation,
    sun,
  })
}

export const getConditions = tool({
  name: 'get_conditions',
  cap: { mutates: false, needs: 'view' },
  description:
    'Read the weather, elevation, and daylight along one route, matched to when the group reaches each spot: temperature low and high (with the motorcycle cold bands), worst rain chance, strongest wind, snow, ice or storms, elevation low and high, and sunrise and sunset where the route ends. Works from the ride as you hold it. An UNKNOWN answer is not a clear one: say so to the rider. One route per call.',
  schema: z.object({ route_uid: z.string().min(1).max(12) }).strict(),
  run: async (ctx, input) => conditionsFor(ctx, input.route_uid),
})
