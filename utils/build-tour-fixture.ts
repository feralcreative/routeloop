// Builds the guided tour's fixture: public/tour/coast-run.json.
//
// THE TOUR IS A CANNED PLANNING SESSION. Ziad's call, 2026-09-11: an
// instructional video about planning a ride, the same every time, with zero
// Google spend per run. Each beat of the tour REPLACES the ride with one of
// the keyframes below through TBBuilder.apply(), so what the rider watches is
// the real builder drawing real roads — roads that were routed ONCE, by
// utils/build-tour-ride.ts, and exported to public/tour/coast-run.routeloop.json.
// This script reads that file and the recorded meeting-point proposal in
// coast-run.meet.json, and makes NO network call. Re-planning the demo means
// re-running build-tour-ride.ts and then this.
//
//   npx tsx utils/build-tour-fixture.ts
//
// UIDS ARE FIXED AND ACCUMULATE. A route or point whose uid changed between
// frames reads to the server's per-route merge as deleted and re-added, which
// churns its base hash and is how a frame comes back `adopted`. So every
// frame carries the same uid for the same thing, starting from the seed in
// src/tour/seed.ts, and a later frame only ever adds.
//
// TIMES ARE AT THE ANCHOR T0 AND SHIFTED AT LOAD. Every startAt below is an
// ISO instant relative to T0, the fixture carries T0, and tour.js moves the
// whole ride by one delta to the coming Saturday at nine — so the frames stay
// valid payloads a test can parse, and the demo never carries a date that
// went stale.
//
// TWO NUMBERS HERE ARE DERIVED RATHER THAN ROUTED, and both are said out
// loud. The main road is cut at the meeting point by slicing the routed
// geometry, with distance and time split in proportion along the line — the
// road is the road, no call needed. The joining group's approach came back
// from the proposer as geometry alone, so its distance is measured along
// that line and its riding time is that distance at the trunk's own average
// speed. Neither is a guess about which road; one is an estimate of how long.
import { readFileSync, writeFileSync } from 'node:fs'
import { ridePayload, type RidePayload } from '../src/maps/ride-graph'
import { GUIDES } from '../src/tour/guides'
import { TOUR_RIDE_TITLE, TOUR_SEED } from '../src/tour/seed'

type LngLat = [number, number]
type Point = RidePayload['routes'][number]['points'][number]
type Leg = RidePayload['routes'][number]['legs'][number]
type Route = RidePayload['routes'][number]

const T0 = '2026-09-19T09:00:00.000Z'
const T0_S = Date.parse(T0) / 1000

// --- Inputs ----------------------------------------------------------------

const native = JSON.parse(readFileSync('public/tour/coast-run.routeloop.json', 'utf8')).ride as RidePayload
const meetSrc = JSON.parse(readFileSync('public/tour/coast-run.meet.json', 'utf8')) as {
  groups: Array<{ group: string; name: string; note: string | null; candidates: Array<Record<string, unknown>> }>
}

const byTitle = (t: string): Route => {
  const r = native.routes.find((x) => x.title === t)
  if (!r) throw new Error(`native fixture has no route titled ${t}`)
  return r
}
const coast = byTitle('Coast run')
const direct = byTitle('Pescadero to Santa Cruz, direct')
const home = byTitle('Home via 84')
const [NAT_MAIN, NAT_SJ] = native.subgroups.map((g) => g.uid)

const [O, A, P, S] = coast.points
const [L1, L2, L3S] = coast.legs
const L3D = direct.legs[0]
const LHOME = home.legs[0]
const SJ = byTitle('San Jose crew').points[0]

// --- Identities ------------------------------------------------------------

const MAIN = { ...TOUR_SEED.group }
const SANJOSE = { uid: 'toursgsanjos', name: 'San Jose crew', color: '#a3541c' }
const HOME = { uid: 'toursghome01', name: 'Heading home', color: '#2a7a2a' }

const R = {
  main: TOUR_SEED.routeUid,
  sanJose: 'tourroute002',
  together: 'tourroute003',
  peel: 'tourroute004',
  onward: 'tourroute005',
}
const U = {
  oakland: TOUR_SEED.pointUid,
  alices: 'tourpoint002',
  pescadero: 'tourpoint003',
  santaCruz: 'tourpoint004',
  meet: 'tourpoint005',
  sanJose: 'tourpoint006',
  pescaderoOn: 'tourpoint007',
  pescaderoOff: 'tourpoint008',
  redwood: 'tourpoint009',
}

// --- Geometry --------------------------------------------------------------

const EARTH_M = 6371008.8
function haversineM(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_M * Math.asin(Math.sqrt(s))
}
const lineM = (g: LngLat[]): number => g.reduce((n, v, i) => (i ? n + haversineM(g[i - 1], v) : 0), 0)

/** Cuts a leg at the vertex nearest `at`, with the cut point itself placed at
 *  `at`. Distance and time split in proportion along the geometry. */
function cutLeg(leg: Leg, at: LngLat): [Leg, Leg] {
  const g = leg.geometry as LngLat[]
  let k = 0
  let best = Infinity
  g.forEach((v, i) => {
    const d = haversineM(v, at)
    if (d < best) {
      best = d
      k = i
    }
  })
  // The forecourt sits beside the road, not on a vertex of it; the proposer
  // admits a candidate within ON_ROUTE_M and the drawn leg jogs to it.
  if (best > 1000) throw new Error(`meeting point is ${Math.round(best)} m off the main road`)
  const before = g.slice(0, k + 1)
  const after = g.slice(k)
  const total = lineM(g)
  const f = lineM(before) / total
  const d1 = Math.round(leg.distanceM * f)
  const s1 = Math.round(leg.durationS * f)
  return [
    { geometry: [...before, at], distanceM: d1, durationS: s1, viaPoints: [] },
    { geometry: [at, ...after], distanceM: leg.distanceM - d1, durationS: leg.durationS - s1, viaPoints: [] },
  ]
}

// --- Points ----------------------------------------------------------------

const pt = (src: Point, uid: string, over: Partial<Point> = {}): Point => ({
  ...src,
  ...over,
  roles: [...(over.roles ?? src.roles)],
  uid,
  details: null,
})
const poi = (src: Point, uid: string): Point => pt(src, uid, { kind: 'poi', roles: [], durationMin: null })
const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x))

const route = (uid: string, over: Partial<Route>): Route => ({
  uid,
  subgroupUid: null,
  title: '',
  color: MAIN.color,
  startAt: null,
  endAt: null,
  altGroup: null,
  altActive: true,
  routePrefs: null,
  points: [],
  legs: [],
  ...over,
})

const iso = (s: number): string => new Date(Math.floor(s / 60) * 60 * 1000).toISOString()

// --- The story -------------------------------------------------------------

type Frame = { id: string; ride: RidePayload }
const frames: Frame[] = []
let cur: RidePayload = {
  title: TOUR_RIDE_TITLE,
  description: '',
  visibility: 'private',
  external_url: '',
  subgroups: [MAIN],
  primarySubgroup: MAIN.uid,
  trunkSubgroup: null,
  stopByMin: null,
  timeAnchor: 'departure',
  routes: [route(R.main, { points: [pt(O, U.oakland, { roles: ['start'] })] })],
}
const push = (id: string, mutate: (p: RidePayload) => void): void => {
  cur = copy(cur)
  mutate(cur)
  const parsed = ridePayload.safeParse(cur)
  if (!parsed.success) throw new Error(`frame ${id} invalid: ${JSON.stringify(parsed.error.issues[0])}`)
  frames.push({ id, ride: copy(cur) })
}
const main = (p: RidePayload): Route => p.routes.find((r) => r.uid === R.main)!
const together = (p: RidePayload): Route => p.routes.find((r) => r.uid === R.together)!

push('named', () => {})
push('point2', (p) => {
  main(p).points.push(poi(A, U.alices))
  main(p).legs.push(copy(L1))
})
push('point3', (p) => {
  main(p).points.push(poi(P, U.pescadero))
  main(p).legs.push(copy(L2))
})
push('point4', (p) => {
  main(p).points.push(poi(S, U.santaCruz))
  main(p).legs.push(copy(L3D))
})
push('via', (p) => {
  main(p).legs[2] = copy(L3S)
})
push('category', (p) => {
  const [, a, pe, s] = main(p).points
  Object.assign(a, { kind: 'stop', roles: ['coffee'] })
  Object.assign(pe, { kind: 'stop', roles: ['food'] })
  Object.assign(s, { kind: 'stop', roles: ['finish'] })
})
push('dwell', (p) => {
  main(p).points[1].durationMin = 30
  main(p).points[2].durationMin = 45
})
push('start', (p) => {
  main(p).startAt = T0
})
push('bed', (p) => {
  p.stopByMin = 16 * 60
})
push('group', (p) => {
  p.subgroups.push(SANJOSE)
  p.routes.push(route(R.sanJose, { subgroupUid: SANJOSE.uid, color: SANJOSE.color, points: [pt(SJ, U.sanJose, { roles: ['start'] })] }))
})
push('gas', (p) => {
  main(p).points[2].roles = ['food', 'gas']
})

// The meet. The proposer's first candidate is a Chevron in Hayward on the main
// road; the main route is cut there, the shared remainder becomes its own
// route starting at the arrival, and the joining group gets a route from San
// Jose to the forecourt timed to arrive at the same moment.
const cand = meetSrc.groups[0].candidates[0]
const MEET: LngLat = [cand.lng as number, cand.lat as number]
const [L1A, L1B] = cutLeg(L1, MEET)
const approachGeom = cand.approach as LngLat[]
const approachM = Math.round(lineM(approachGeom))
const trunkMps = coast.legs.reduce((n, l) => n + l.distanceM, 0) / coast.legs.reduce((n, l) => n + l.durationS, 0)
const APPROACH: Leg = { geometry: approachGeom, distanceM: approachM, durationS: Math.round(approachM / trunkMps), viaPoints: [] }
const arriveMeetS = T0_S + L1A.durationS
const meetPoint: Point = {
  kind: 'stop',
  lng: MEET[0],
  lat: MEET[1],
  name: String(cand.name),
  address: String(cand.address),
  description: '',
  roles: ['meet', 'gas'],
  durationMin: null,
  slackMin: null,
  uid: U.meet,
  details: null,
}

push('meet', (p) => {
  const m = main(p)
  const [o, a, pe, s] = m.points
  const tail = route(R.together, {
    title: 'Together from ' + meetPoint.name,
    color: '#8800dd',
    startAt: iso(arriveMeetS),
    points: [pt(meetPoint, 'tourpoint011'), a, pe, s],
    legs: [L1B, m.legs[1], m.legs[2]],
  })
  m.subgroupUid = MAIN.uid
  m.points = [o, copy(meetPoint)]
  m.legs = [L1A]
  const sj = p.routes.find((r) => r.uid === R.sanJose)!
  sj.points.push(copy(meetPoint))
  sj.points[1].uid = 'tourpoint010'
  sj.legs = [copy(APPROACH)]
  sj.startAt = iso(arriveMeetS - APPROACH.durationS)
  // The shared route goes after the last approach, per cutSharedStretch.
  p.routes = [m, sj, tail]
})

// The split, at Pescadero: Diego turns for home over 84 and everybody else
// carries on to Santa Cruz. Both new routes start at the arrival.
push('split', (p) => {
  const t = together(p)
  const [meet, a, pe, s] = t.points
  const arrivePS = arriveMeetS + t.legs[0].durationS + (a.durationMin ?? 0) * 60 + t.legs[1].durationS
  const onward = route(R.onward, {
    subgroupUid: MAIN.uid,
    color: '#ff6f00',
    startAt: iso(arrivePS),
    points: [pt(pe, U.pescaderoOn, { roles: ['start'], durationMin: null }), s],
    legs: [t.legs[2]],
  })
  const peel = route(R.peel, {
    subgroupUid: HOME.uid,
    color: HOME.color,
    startAt: iso(arrivePS),
    points: [pt(pe, U.pescaderoOff, { roles: ['start'], durationMin: null }), pt(home.points[1], U.redwood, { roles: ['finish'] })],
    legs: [copy(LHOME)],
  })
  t.points = [meet, a, pe]
  t.legs = t.legs.slice(0, 2)
  p.subgroups.push(HOME)
  const i = p.routes.indexOf(t)
  p.routes.splice(i + 1, 0, onward)
  p.routes.push(peel)
})

// --- The recorded proposal, with the tour's group uids ---------------------

const uidMap: Record<string, string> = { [NAT_MAIN]: MAIN.uid, [NAT_SJ]: SANJOSE.uid }
const meet = {
  groups: meetSrc.groups.map((g) => ({
    ...g,
    group: uidMap[g.group] ?? g.group,
    candidates: g.candidates.map((c) => ({
      ...c,
      diverts: (c.diverts as Array<{ group: string }>).map((d) => ({ ...d, group: uidMap[d.group] ?? d.group })),
    })),
  })),
}

// --- Out -------------------------------------------------------------------

const guide = (n: number) => GUIDES[n].username
const fixture = {
  version: 1,
  t0: T0,
  title: TOUR_RIDE_TITLE,
  keyframes: frames,
  meet,
  // Home groups for the Riders beat: the two long tanks ride in from San Jose,
  // the short one rides with the planner from Oakland.
  members: [
    { guide: guide(0), group: SANJOSE.uid },
    { guide: guide(1), group: SANJOSE.uid },
  ],
  // Who rides which route after the split, written through
  // PUT /api/rides/:id/route-riders/:uid exactly as writeSplitRiders does.
  split: {
    at: { routeUid: R.together, pointUid: U.pescadero },
    peel: { routeUid: R.peel, riders: [{ guide: guide(2), group: HOME.uid }] },
    onward: { routeUid: R.onward, riders: [{ owner: true }, { guide: guide(0) }, { guide: guide(1) }] },
  },
  // Where the map should be for each typed search, so the demonstration's
  // caret types over the right piece of map.
  boxes: {
    peninsula: [
      [-122.45, 37.2],
      [-122.0, 37.85],
    ] as [LngLat, LngLat],
  },
}

// LEGS ARE STORED ONCE AND REFERENCED BY KEY. Thirteen frames each carrying
// the same routed geometry is 740 KB; deduplicated it is under 130. A frame's
// leg is `{ ref, viaPoints }` and tour.js inflates it back to the payload
// shape before applying — five lines there, and the same five in
// test/tour-fixture.test.ts, which validates every inflated frame.
const legs: Record<string, Omit<Leg, 'viaPoints'>> = {}
const keyOf = new Map<string, string>()
const compact = frames.map((f) => ({
  id: f.id,
  ride: {
    ...f.ride,
    routes: f.ride.routes.map((r) => ({
      ...r,
      legs: r.legs.map((l) => {
        const sig = JSON.stringify([l.geometry, l.distanceM, l.durationS])
        let key = keyOf.get(sig)
        if (!key) {
          key = 'leg' + (keyOf.size + 1)
          keyOf.set(sig, key)
          legs[key] = { geometry: l.geometry, distanceM: l.distanceM, durationS: l.durationS }
        }
        return { ref: key, viaPoints: l.viaPoints ?? [] }
      }),
    })),
  },
}))
const out = JSON.stringify({ ...fixture, keyframes: compact, legs })
writeFileSync('public/tour/coast-run.json', out + '\n')
console.log(
  `[tour] wrote public/tour/coast-run.json: ${frames.length} keyframes, ${(out.length / 1024).toFixed(0)} KB; ` +
    `meet at ${meetPoint.name} ${(L1A.distanceM / 1609.344).toFixed(1)} mi in, approach ${(approachM / 1609.344).toFixed(1)} mi / ${Math.round(APPROACH.durationS / 60)} min`,
)
