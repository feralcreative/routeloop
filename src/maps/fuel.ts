// The fuel walk, server side: the same arithmetic the map draws with, for the
// planning assistant's get_fuel_plan and check_ride, which cannot see the map.
//
// A PORT, PINNED: public/js/range-circle.js and public/js/route-distance.js are what
// the builder and the viewer draw from, and test/fuel-port.test.ts evaluates both
// browser files and requires these functions to agree with them on every fixture.
// Two copies that drift would have the assistant tell a rider their ride is covered
// while the map shows an E (#451's "the map, the summary, and the auditor change
// together").
//
// Meters throughout, as the browser files are. PURE.

export type FuelPoint = { roles: readonly string[]; uid?: string | null; name?: string | null }
export type FuelLeg = { distanceM: number }
export type FuelRoute = { points: FuelPoint[]; legs: FuelLeg[]; subgroupUid?: string | null }

const legMeters = (leg: FuelLeg | undefined) =>
  leg && typeof leg.distanceM === 'number' && isFinite(leg.distanceM) && leg.distanceM > 0 ? leg.distanceM : 0

/** Meters from the start of the route to each point. route-distance.js cumulativeM(). */
export function cumulativeM(route: FuelRoute): number[] {
  const out: number[] = []
  let run = 0
  route.points.forEach((_, i) => {
    out.push(run)
    run += legMeters(route.legs[i])
  })
  return out
}

export const isRefuel = (p: FuelPoint | undefined, role: string | null): boolean =>
  !!p && !!role && Array.isArray(p.roles) && p.roles.includes(role)

/** range-circle.js lastFillM(). */
export function lastFillM(route: FuelRoute, distM: number, cum: number[], role: string | null, carryM = 0): number {
  let last = carryM > 0 ? -carryM : 0
  route.points.forEach((p, i) => {
    if (isRefuel(p, role) && cum[i] <= distM) last = cum[i]
  })
  return last
}

/** range-circle.js dryDistancesM(): every wall, one per tankful. */
export function dryDistancesM(
  route: FuelRoute,
  distM: number,
  cum: number[],
  role: string | null,
  rangeM: number | null,
  carryM = 0,
): number[] {
  if (!cum.length || !(rangeM != null && rangeM > 0)) return []
  const total = cum[cum.length - 1]
  const pumps = route.points.flatMap((p, i) => (isRefuel(p, role) ? [cum[i]] : []))
  const out: number[] = []
  let tank = lastFillM(route, distM, cum, role, carryM)
  let k = 0
  for (;;) {
    while (k < pumps.length && pumps[k] <= tank) k++
    while (k < pumps.length && pumps[k] <= tank + rangeM) tank = pumps[k++]
    const dry = tank + rangeM
    if (dry > total) break
    out.push(Math.max(0, dry))
    tank = dry
  }
  return out
}

/** range-circle.js carriesM(): how far into the tank each route starts. */
export function carriesM(
  routes: FuelRoute[],
  role: string | null,
  rangeM: number | null,
  isActive: (r: FuelRoute) => boolean,
): number[] {
  const out = routes.map(() => 0)
  if (!(rangeM != null && rangeM > 0) || !role) return out
  const left: (number | null)[] = []
  const tagOf = (r: FuelRoute) => r.subgroupUid || null
  routes.forEach((r, i) => {
    left.push(null)
    if (!isActive(r)) return
    const tag = tagOf(r)
    const tags: (string | null)[] = [tag]
    if (tag === null) {
      for (let k = 0; k < i; k++) {
        const tk = tagOf(routes[k])
        if (tk !== null && isActive(routes[k]) && !tags.includes(tk)) tags.push(tk)
      }
      if (tags.length > 1) tags.shift()
    }
    let carry = 0
    for (const t of tags)
      for (let j = i - 1; j >= 0; j--) {
        const lj = left[j]
        if (lj == null) continue
        const tj = tagOf(routes[j])
        if (tj === null || tj === t) {
          carry = Math.max(carry, lj)
          break
        }
      }
    if (isRefuel(r.points[0], role)) carry = 0
    out[i] = carry
    const cum = cumulativeM(r)
    if (!cum.length) {
      left[i] = carry
      return
    }
    const total = cum[cum.length - 1]
    const walls = dryDistancesM(r, 0, cum, role, rangeM, carry).filter((w) => w < total)
    let origin = lastFillM(r, total, cum, role, carry)
    if (walls.length) origin = Math.max(origin, walls[walls.length - 1])
    left[i] = Math.max(0, total - origin)
  })
  return out
}

/** route-distance.js sinceRefuelM(): meters on the current tank at each point. */
export function sinceRefuelM(route: FuelRoute, role: string | null, carryM = 0): number[] {
  const cum = cumulativeM(route)
  let last = carryM > 0 ? -carryM : 0
  return route.points.map((p, i) => {
    if (isRefuel(p, role)) last = cum[i]
    return cum[i] - last
  })
}

export type FuelGap = {
  /** Meters along the route where the stretch starts (the last fill, or the start). */
  fromM: number
  /** Meters along the route where it ends (the next fill, or the end). */
  toM: number
  /** How far that is, including what was carried in when it starts at the route's start. */
  lengthM: number
}

export type RouteFuelPlan = {
  carryM: number
  /** Every wall: where the tank runs dry, one per tankful. Empty means covered. */
  wallsM: number[]
  /** Every stretch between fills, longest first. */
  gaps: FuelGap[]
  /** Pumps that are themselves past a wall: reachable only after a fill nobody planned. */
  unreachable: number[]
}

/** The whole picture for one route: what the map's E markers, red stretch and row
 *  flags say, in numbers. */
export function routeFuelPlan(route: FuelRoute, role: string | null, rangeM: number | null, carryM = 0): RouteFuelPlan {
  const cum = cumulativeM(route)
  const total = cum.length ? cum[cum.length - 1] : 0
  const wallsM = dryDistancesM(route, 0, cum, role, rangeM, carryM)
  const fills = route.points.flatMap((p, i) => (isRefuel(p, role) && i > 0 ? [i] : []))
  const starts = isRefuel(route.points[0], role) || !carryM ? 0 : -carryM
  const marks = [starts, ...fills.map((i) => cum[i]), total]
  const gaps: FuelGap[] = []
  for (let k = 0; k + 1 < marks.length; k++) {
    const fromM = Math.max(0, marks[k])
    gaps.push({ fromM, toM: marks[k + 1], lengthM: marks[k + 1] - marks[k] })
  }
  gaps.sort((a, b) => b.lengthM - a.lengthM)
  const firstWall = wallsM[0]
  const unreachable = firstWall == null ? [] : fills.filter((i) => cum[i] > firstWall)
  return { carryM, wallsM, gaps, unreachable }
}
