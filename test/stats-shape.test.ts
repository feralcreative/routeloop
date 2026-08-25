// The dashboard's arithmetic.
//
// Everything here is a number a rider reads and cannot check. A wrong one does
// not crash and does not look wrong — it just quietly misrepresents their own
// library back to them, which is worse than an error page.
//
// Four things are pinned harder than the rest, because each is a judgment that
// could plausibly have gone the other way and would be invisible if it had:
//
//   - twistiness rolls up distance-weighted, so a short twisty loop cannot
//     outvote a long transit day
//   - a null twistiness is "not measured", never "Straight"
//   - the month series is dense, so a gap in activity draws as a gap
//   - the storage meter is absent at zero rather than showing 0%
//
// The SQL that feeds this lives in src/stats/query.ts and is deliberately not
// tested — it needs a database. This covers the shaping; the queries are checked
// by hand against a seeded rider.
import { describe, expect, it } from 'vitest'
import { ROLE_META } from '../src/maps/roles'
import { TWIST_BANDS } from '../src/maps/twist'
import {
  ACTIVITY_MONTHS,
  fmtBytes,
  fmtHours,
  fmtMiles,
  monthSeries,
  roleBars,
  roleTotalExceedsPoints,
  rollUpTwist,
  shapeStats,
} from '../src/stats/shape'
import type { RawStats, RawTotals } from '../src/stats/shape'

const MI = 1609.344
const NOW = new Date('2026-08-08T12:00:00Z')

const totals = (over: Partial<RawTotals> = {}): RawTotals => ({
  rides: 0,
  days: 0,
  legs: 0,
  points: 0,
  stops: 0,
  pois: 0,
  distanceM: 0,
  viaPoints: 0,
  durationS: 0,
  estimatedLegs: 0,
  publicRides: 0,
  unlistedRides: 0,
  privateRides: 0,
  views: 0,
  storedBytes: 0,
  quotaBytes: 26214400,
  ...over,
})

const raw = (over: Partial<RawStats> = {}): RawStats => ({
  totals: totals(),
  twist: [],
  roles: [],
  months: [],
  records: {
    longestDayM: null,
    biggestRideM: null,
    biggestRideTitle: null,
    biggestRideSlug: null,
    bestTwistDpm: null,
    mostViewed: null,
    mostViewedTitle: null,
    mostViewedSlug: null,
  },
  ...over,
})

describe('rollUpTwist', () => {
  // THE test in this file. A 30-mile loop at 300°/mi and a 300-mile day at
  // 50°/mi: the honest answer is close to 50, because almost all the miles were
  // the straight ones. A mean of the two figures says 175 — "Twisty" — which
  // describes a library the rider does not have.
  it('weights by distance, not by route', () => {
    const rolled = rollUpTwist([
      { dpm: 300, distanceM: 30 * MI },
      { dpm: 50, distanceM: 300 * MI },
    ])
    const naiveMean = (300 + 50) / 2
    expect(rolled?.dpm).toBe(73)
    expect(rolled?.dpm).toBeLessThan(naiveMean)
  })

  it('agrees with the plain mean when the distances are equal', () => {
    expect(rollUpTwist([{ dpm: 100, distanceM: MI }, { dpm: 200, distanceM: MI }])?.dpm).toBe(150)
  })

  // Null is not zero. days.twistiness_dpm is nullable and query.ts filters
  // nulls out before they arrive, so an empty list means "nothing measured" —
  // and the one thing it must never do is fall through to the 0 band.
  it('returns null when nothing has been measured, rather than "Straight"', () => {
    expect(rollUpTwist([])).toBeNull()
    expect(TWIST_BANDS.at(-1)?.label).toBe('Straight')
  })

  it('reports a genuine zero as Straight', () => {
    expect(rollUpTwist([{ dpm: 0, distanceM: 100 * MI }])).toEqual({ dpm: 0, label: 'Straight' })
  })

  // A route with no distance carries no weight and must not divide by zero.
  it('ignores zero-length days', () => {
    expect(rollUpTwist([{ dpm: 999, distanceM: 0 }])).toBeNull()
    expect(rollUpTwist([{ dpm: 999, distanceM: 0 }, { dpm: 100, distanceM: MI }])?.dpm).toBe(100)
  })

  it('carries the band label, not just the number', () => {
    expect(rollUpTwist([{ dpm: 250, distanceM: MI }])?.label).toBe('Very twisty')
  })
})

describe('roleBars', () => {
  it('sorts biggest first and scales share against the biggest bar', () => {
    const bars = roleBars([
      { role: 'gas', n: 4 },
      { role: 'camp', n: 12 },
      { role: 'coffee', n: 6 },
    ])
    expect(bars.map((b) => b.role)).toEqual(['camp', 'coffee', 'gas'])
    expect(bars[0].share).toBe(1)
    expect(bars[2].share).toBeCloseTo(4 / 12)
  })

  it('uses the human label and the existing icon', () => {
    const [bar] = roleBars([{ role: 'wtf', n: 1 }])
    expect(bar.label).toBe(ROLE_META.wtf.title)
    expect(bar.icon).toBe(ROLE_META.wtf.icon)
  })

  // Seventeen rows of which four have data is a chart about the taxonomy.
  it('drops roles nobody used', () => {
    expect(roleBars([{ role: 'gas', n: 0 }, { role: 'camp', n: 3 }]).map((b) => b.role)).toEqual(['camp'])
  })

  // A role removed from ROLE_META but still on old rows must not crash the page.
  it('ignores a role it does not recognize', () => {
    expect(roleBars([{ role: 'teleporter', n: 9 }])).toEqual([])
  })

  // Every ride has a start and an end, so both arrive with a count equal to the
  // number of days and sit at the top of a chart called "what you stop for" —
  // burying the categories the rider actually chose. Caught by rendering it.
  it('drops start and finish, which every route has by construction', () => {
    const bars = roleBars([
      { role: 'start', n: 20 },
      { role: 'finish', n: 20 },
      { role: 'gas', n: 10 },
      { role: 'coffee', n: 1 },
    ])
    expect(bars.map((b) => b.role)).toEqual(['gas', 'coffee'])
    // And the scale is re-based on what remains, so gas is a full bar rather
    // than half of a structural one.
    expect(bars[0].share).toBe(1)
  })

  // Starting from your own door IS a choice, and not every ride makes it.
  it('keeps home', () => {
    expect(roleBars([{ role: 'home', n: 4 }]).map((b) => b.role)).toEqual(['home'])
  })

  it('is empty for a rider with nothing', () => {
    expect(roleBars([])).toEqual([])
  })
})

describe('roleTotalExceedsPoints', () => {
  // roles is an array of up to 4 per point, so one stop can appear in four bars.
  // The page has to admit that or the bars look like they were counted wrong.
  it('is true when points carry more than one role', () => {
    const bars = roleBars([{ role: 'gas', n: 10 }, { role: 'food', n: 8 }])
    expect(roleTotalExceedsPoints(bars, 12)).toBe(true)
  })

  it('is false when every point carries at most one role', () => {
    const bars = roleBars([{ role: 'gas', n: 5 }, { role: 'food', n: 5 }])
    expect(roleTotalExceedsPoints(bars, 10)).toBe(false)
  })
})

describe('monthSeries', () => {
  it('returns a dense run of months ending at now', () => {
    const s = monthSeries([], NOW)
    expect(s).toHaveLength(ACTIVITY_MONTHS)
    expect(s.at(-1)?.month).toBe('2026-08')
    expect(s[0].month).toBe('2025-09')
    expect(s.every((p) => p.n === 0)).toBe(true)
  })

  // The reason it is dense. SQL returns only months that had a ride, so a
  // January and a June would otherwise draw one straight segment across five
  // silent months — a line claiming steady activity that never happened.
  it('fills a gap with zeroes instead of joining across it', () => {
    const s = monthSeries([{ month: '2026-01', n: 3 }, { month: '2026-06', n: 2 }], NOW)
    expect(s.find((p) => p.month === '2026-01')?.n).toBe(3)
    expect(s.find((p) => p.month === '2026-03')?.n).toBe(0)
    expect(s.find((p) => p.month === '2026-06')?.n).toBe(2)
  })

  it('crosses a year boundary correctly', () => {
    const s = monthSeries([{ month: '2025-12', n: 1 }], NOW)
    expect(s.find((p) => p.month === '2025-12')?.n).toBe(1)
  })

  it('ignores a month outside the window', () => {
    expect(monthSeries([{ month: '2020-01', n: 99 }], NOW).every((p) => p.n === 0)).toBe(true)
  })

  it('labels months in UTC, so the boundary does not shift by timezone', () => {
    // 1 Jan 00:30 UTC is still December in US local time; the label must not slip.
    expect(monthSeries([], new Date('2026-01-01T00:30:00Z')).at(-1)?.label).toBe('Jan')
  })
})

describe('fmtBytes and fmtMiles', () => {
  it.each([
    [512, '512 B'],
    [2048, '2 KB'],
    [1024 * 1024 * 3.5, '3.5 MB'],
    [1024 * 1024 * 1024 * 2, '2.0 GB'],
  ])('%i renders as %s', (n, expected) => {
    expect(fmtBytes(n)).toBe(expected)
  })

  it('groups thousands in mileage', () => {
    expect(fmtMiles(12345 * MI)).toBe('12,345')
  })
})

describe('shapeStats', () => {
  it('survives a rider with nothing at all', () => {
    const s = shapeStats(raw(), 0, NOW)
    expect(s.hasRides).toBe(false)
    expect(s.heroMiles).toBe('0')
    expect(s.meter).toBeNull()
    expect(s.twist).toBeNull()
    expect(s.roles).toEqual([])
    expect(s.records).toEqual([])
    expect(s.months).toHaveLength(ACTIVITY_MONTHS)
    // Every visibility share must be a number, not NaN from 0/0.
    expect(s.visibility.every((v) => Number.isFinite(v.pct))).toBe(true)
  })

  // The builder-only rider. This is the case that made the meter conditional.
  it('hides the meter entirely when nothing has been imported', () => {
    expect(shapeStats(raw({ totals: totals({ rides: 9, days: 20 }) }), 0, NOW).meter).toBeNull()
  })

  it('shows the meter once something is stored', () => {
    const s = shapeStats(raw({ totals: totals({ storedBytes: 1024 * 1024 * 5 }) }), 1024 * 1024 * 5, NOW)
    expect(s.meter?.used).toBe('5.0 MB')
    expect(s.meter?.pct).toBeCloseTo(20)
  })

  it('clamps the meter at 100% rather than overflowing the track', () => {
    const over = totals({ storedBytes: 26214400 * 3, quotaBytes: 26214400 })
    expect(shapeStats(raw({ totals: over }), 0, NOW).meter?.pct).toBe(100)
  })

  // The cache has no reconciler and was already wrong on a real account.
  it('notices when used_bytes disagrees with the authoritative sum', () => {
    const t = totals({ storedBytes: 383_000 })
    expect(shapeStats(raw({ totals: t }), 0, NOW).storageDrift).toBe(true)
    expect(shapeStats(raw({ totals: t }), 383_000, NOW).storageDrift).toBe(false)
  })

  it('counts every dot, and says how it splits', () => {
    const s = shapeStats(raw({ totals: totals({ points: 30, stops: 22, pois: 8 }) }), 0, NOW)
    const tile = s.tiles.find((x) => x.label === 'waypoints')
    expect(tile?.value).toBe('30')
    expect(tile?.hint).toContain('22 stops')
    expect(tile?.hint).toContain('8 points of interest')
  })

  it('uses singular labels for one of a thing', () => {
    const s = shapeStats(raw({ totals: totals({ rides: 1, days: 1, legs: 1, points: 1 }) }), 0, NOW)
    expect(s.tiles.map((t) => t.label)).toEqual(['ride', 'day', 'leg', 'waypoint'])
  })

  it('only mentions shaping points when there are some', () => {
    expect(shapeStats(raw(), 0, NOW).tiles.some((t) => t.label.includes('insisted'))).toBe(false)
    const dragged = shapeStats(raw({ totals: totals({ viaPoints: 14 }) }), 0, NOW)
    expect(dragged.tiles.find((t) => t.label.includes('insisted'))?.value).toBe('14')
  })

  it('splits visibility into percentages that sum to 100', () => {
    const t = totals({ rides: 4, publicRides: 1, unlistedRides: 1, privateRides: 2 })
    const s = shapeStats(raw({ totals: t }), 0, NOW)
    expect(s.visibility.reduce((n, v) => n + v.pct, 0)).toBeCloseTo(100)
    expect(s.visibility.find((v) => v.key === 'private')?.pct).toBe(50)
  })

  // Records are omitted rather than shown as zero or an em dash: a record nobody
  // has set is not a fact about the rider.
  it('omits records that do not exist yet', () => {
    expect(shapeStats(raw(), 0, NOW).records).toEqual([])
  })

  it('renders the records it has', () => {
    const s = shapeStats(
      raw({
        records: {
          longestDayM: 420 * MI,
          biggestRideM: 2100 * MI,
          biggestRideTitle: 'Sierras',
          biggestRideSlug: 'abc',
          bestTwistDpm: 260,
          mostViewed: 12,
          mostViewedTitle: 'Coast Run',
          mostViewedSlug: 'xyz',
        },
      }),
      0,
      NOW,
    )
    const labels = s.records.map((x) => x.label)
    expect(labels).toContain('Longest single day')
    expect(s.records.find((x) => x.label === 'Longest single day')?.value).toBe('420 mi')
    expect(s.records.find((x) => x.label === 'Twistiest 20 miles')?.value).toBe('Very twisty')
    expect(labels.some((l) => l.includes('12 times'))).toBe(true)
  })

  it('does not claim a twistiest stretch when none was measured', () => {
    const s = shapeStats(raw({ records: { ...raw().records, bestTwistDpm: null } }), 0, NOW)
    expect(s.records.some((x) => x.label === 'Twistiest 20 miles')).toBe(false)
  })

  // SADDLE TIME. This block replaced a test asserting that no duration figure
  // appeared anywhere — that rule held from the day the dashboard was built until
  // 2026-08-24, on the grounds that the import path writes no leg duration and a
  // total would therefore undercount. The undercount was fixed instead of the
  // figure being withheld (query.ts estimates an unrouted leg from distance), so
  // the old assertion pinned a rule that no longer exists and was rewritten
  // rather than patched to pass.
  describe('saddle time', () => {
    it('is null when nothing has any riding time, rather than a confident zero', () => {
      const s = shapeStats(raw({ totals: totals({ rides: 5, distanceM: 1000 * MI }) }), 0, NOW)
      expect(s.saddle).toBe(null)
    })

    it('reports whole hours', () => {
      const s = shapeStats(raw({ totals: totals({ rides: 1, durationS: 3600 * 12 }) }), 0, NOW)
      expect(s.saddle?.hours).toBe('12')
    })

    it('groups thousands, because a long-standing library gets there', () => {
      const s = shapeStats(raw({ totals: totals({ rides: 1, durationS: 3600 * 1234 }) }), 0, NOW)
      expect(s.saddle?.hours).toBe('1,234')
    })

    // The whole point of carrying the flag: the same number means different
    // things depending on whether a router measured it or distance implied it.
    it('says the figure is measured when no leg was estimated', () => {
      const s = shapeStats(raw({ totals: totals({ rides: 1, durationS: 7200, estimatedLegs: 0 }) }), 0, NOW)
      expect(s.saddle?.estimated).toBe(false)
      expect(s.saddle?.note).toMatch(/measured/i)
    })

    it('admits the figure is part estimated when any leg was', () => {
      const s = shapeStats(raw({ totals: totals({ rides: 1, durationS: 7200, estimatedLegs: 1 }) }), 0, NOW)
      expect(s.saddle?.estimated).toBe(true)
      expect(s.saddle?.note).toMatch(/estimated/i)
    })
  })
})

describe('fmtHours', () => {
  it('rounds to the nearest hour rather than truncating', () => {
    expect(fmtHours(3600 * 2 + 1800)).toBe('3')
    expect(fmtHours(3600 * 2 + 1799)).toBe('2')
  })

  // Hours and nothing smaller, unlike the roadbook's fmtDuration. A minute is
  // information about one day and noise across a hundred, and some unknown share
  // of this figure is estimated anyway.
  it('never prints minutes', () => {
    expect(fmtHours(3600 * 4 + 1200)).toBe('4')
  })
})
