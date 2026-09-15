// The roadbook's rows, as arithmetic. Lifted out of src/routes/roadbook.tsx on
// 2026-09-14 when the on-the-road page (#69) became a second reader: a phone
// surface that folds the roadbook in has to print the same leg, total,
// since-fuel and arrival figures the printed sheet does, and two copies of this
// walk would disagree the first time one of them was touched. No Hono, no
// formatting — a caller renders a Row in its own units and its own clock.
import type { ExportPoint, ExportRoute } from './export'

// A row is a stop or a POI, already in along-the-route order.
export type Row = {
  point: ExportPoint
  n: number | null // stop number; POIs are not numbered
  fromPrevM: number | null
  atM: number | null
  sinceFuelM: number | null
  arrive: Date | null
}

// "4h 20m", or "35m" under the hour. A dash rather than "0m" when the router
// never answered for a leg — a dash reads as unknown, 0m reads as instant.
//
// Used for dwell too, where the raw minutes are unreadable: an overnight camp
// stop printed "658m" before this, which nobody parses at a glance.
export function fmtDuration(seconds: number): string {
  if (seconds <= 0) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

// Everything the sheet needs, computed once per route.
//
// `sinceFuel` is the column that earns its place: the distance since the last
// stop that could fill a tank. A rider with a 180-mile range needs to see 210
// coming, and no other view in the app says it.
//
// It reads *as you arrive*, so a fuel stop shows the distance you just covered
// on that tank rather than the 0 you are about to reset to. That is the number
// worth printing: it tells you what the bike actually did on the last tank, and
// the 0 says nothing you did not already know from the word "Gas" in the row.
export function routeRows(route: ExportRoute): Row[] {
  // THE RIDER'S OWN ORDER, which is the order the rows arrive in — every point
  // carries a position now and loadRideForExport reads by it.
  //
  // This used to sort by `distFromStartM`, because a POI had no stored order and
  // its projection onto the track was the only thing that could place it. That
  // is no longer true, and the projection is now the worse answer of the two: it
  // is null on a trackless import and on any point nothing measured, and a null
  // sorted to the end moved a point the rider had put in the middle. The printed
  // sheet should say what the rider planned.
  const ordered = route.points

  // Riding seconds are known per route, not per leg-between-stops, so they are
  // spread across the route's distance. That is an estimate and the header says
  // so; the alternative is no clock at all, which is worse on a sheet whose
  // whole job is telling you whether you are behind.
  const perMeter = route.distanceM > 0 ? route.durationS / route.distanceM : 0

  const rows: Row[] = []
  let n = 0
  let prevM = 0
  let fuelAtM = 0
  let sawFuel = false
  let clock = route.startAt ? new Date(route.startAt) : null

  for (const p of ordered) {
    const isPoi = p.kind === 'poi'
    const at = p.distFromStartM

    if (at == null) {
      rows.push({ point: p, n: isPoi ? null : ++n, fromPrevM: null, atM: null, sinceFuelM: null, arrive: null })
      continue
    }

    if (clock) clock = new Date(clock.getTime() + (at - prevM) * perMeter * 1000)
    const arrive = clock ? new Date(clock) : null
    if (clock && p.durationMin) clock = new Date(clock.getTime() + p.durationMin * 60_000)

    rows.push({
      point: p,
      n: isPoi ? null : ++n,
      // null, not 0, for the first point of the route: there is no leg before it.
      // Same convention as atM and sinceFuelM — a dash means "no answer", and
      // relying on 0 being falsy in the template would make the value itself a
      // lie for anything that read it directly.
      fromPrevM: rows.length === 0 ? null : at - prevM,
      atM: at,
      sinceFuelM: sawFuel ? at - fuelAtM : null,
      arrive,
    })

    // Charge counts: an EV rider's range question is the same question.
    if (p.roles.includes('gas') || p.roles.includes('charge')) {
      fuelAtM = at
      sawFuel = true
    }
    prevM = at
  }
  return rows
}
