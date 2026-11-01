// src/maps/fuel.ts is a port of the arithmetic the map draws fuel with. These run
// both on the same rides and require the same answers, so the assistant cannot tell
// a rider their ride is covered while the map shows an E (#451).
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { carriesM, cumulativeM, dryDistancesM, lastFillM, routeFuelPlan, sinceRefuelM, type FuelRoute } from '../src/maps/fuel'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let R: any, D: any

beforeAll(() => {
  const win: Record<string, unknown> = {}
  new Function('window', readFileSync('public/js/range-circle.js', 'utf8'))(win)
  new Function('window', readFileSync('public/js/route-distance.js', 'utf8'))(win)
  R = win.TBRange
  D = win.TBDistance
})

const MI = 1609.344

/** A deterministic pseudo-random ride, so a failure names a seed you can rerun. */
function ride(seed: number): FuelRoute[] {
  let x = seed
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const routes: FuelRoute[] = []
  const n = 1 + Math.floor(rnd() * 5)
  const tags = [null, null, 'grpA', 'grpB']
  for (let r = 0; r < n; r++) {
    const pts = 2 + Math.floor(rnd() * 6)
    routes.push({
      subgroupUid: tags[Math.floor(rnd() * tags.length)],
      points: Array.from({ length: pts }, () => ({ roles: rnd() < 0.25 ? ['gas'] : rnd() < 0.1 ? ['charge'] : [] })),
      legs: Array.from({ length: pts - 1 }, () => ({ distanceM: Math.round(rnd() * 140 * MI) })),
    })
  }
  return routes
}

const all = () => true

describe('the fuel port agrees with the map', () => {
  for (let seed = 1; seed <= 200; seed++) {
    it(`ride ${seed}`, () => {
      const routes = ride(seed)
      for (const role of ['gas', 'charge'] as const)
        for (const rangeMi of [60, 120, 180]) {
          const rangeM = rangeMi * MI
          const carries = carriesM(routes, role, rangeM, all)
          expect(carries).toEqual(R.carriesM(routes, role, rangeM, D.cumulativeM, all))
          routes.forEach((route, i) => {
            const cum = cumulativeM(route)
            expect(cum).toEqual(D.cumulativeM(route))
            const total = cum[cum.length - 1]
            for (const distM of [0, total / 2, total]) {
              expect(lastFillM(route, distM, cum, role, carries[i])).toBe(R.lastFillM(route, distM, cum, role, carries[i]))
              expect(dryDistancesM(route, distM, cum, role, rangeM, carries[i])).toEqual(
                R.dryDistancesM(route, distM, cum, role, rangeM, carries[i]),
              )
            }
            expect(sinceRefuelM(route, role, carries[i])).toEqual(D.sinceRefuelM(route, role, carries[i]))
          })
        }
    })
  }
})

describe('routeFuelPlan', () => {
  it('names the walls, the longest gap, and a pump past the first wall', () => {
    // Start → 100 → A → 90 → Shell(gas) → 30 → end, on a 150-mile tank.
    const route: FuelRoute = {
      points: [{ roles: [] }, { roles: [] }, { roles: ['gas'] }, { roles: [] }],
      legs: [{ distanceM: 100 * MI }, { distanceM: 90 * MI }, { distanceM: 30 * MI }],
    }
    const plan = routeFuelPlan(route, 'gas', 150 * MI)
    expect(plan.wallsM.map((m) => Math.round(m / MI))).toEqual([150])
    expect(Math.round(plan.gaps[0].lengthM / MI)).toBe(190)
    expect(plan.unreachable).toEqual([2])
  })

  it('counts the carry into the first gap', () => {
    const route: FuelRoute = { points: [{ roles: [] }, { roles: [] }], legs: [{ distanceM: 40 * MI }] }
    const plan = routeFuelPlan(route, 'gas', 150 * MI, 130 * MI)
    expect(Math.round(plan.gaps[0].lengthM / MI)).toBe(170)
    expect(plan.wallsM.map((m) => Math.round(m / MI))).toEqual([20])
  })
})
