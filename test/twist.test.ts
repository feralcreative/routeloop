// Twistiness: the shape metric that replaced "time stopped" in the totals line.
//
// The thresholds inside twist.ts were measured against the dev corpus, not
// guessed, so what matters here is that the maths does what those measurements
// assumed: a straight road scores ~0, a curve scores in proportion to how tight
// it is, the deadband actually suppresses wobble, and the best-window pass finds
// a good stretch buried in a boring day.
import { describe, expect, it } from 'vitest'
import { twistiness, twistLabel, TWIST_BANDS } from '../src/maps/twist'
import type { Track } from '../src/maps/kml'

const R_EARTH = 6371000
const DEG_PER_M_LAT = 180 / (Math.PI * R_EARTH)

/** A due-east straight line of `meters`, sampled every `step` metres. */
function straight(meters: number, step = 20, lat = 37): Track {
  const out: Track = []
  const degPerM = DEG_PER_M_LAT / Math.cos((lat * Math.PI) / 180)
  for (let d = 0; d <= meters; d += step) out.push([-120 + d * degPerM, lat])
  return out
}

/** A circular arc of the given radius sweeping `sweepDeg`, sampled every `step` metres. */
function arc(radiusM: number, sweepDeg: number, step = 20, lat = 37): Track {
  const out: Track = []
  const arcLen = radiusM * sweepDeg * (Math.PI / 180)
  const lonScale = 1 / Math.cos((lat * Math.PI) / 180)
  for (let d = 0; d <= arcLen; d += step) {
    const th = d / radiusM
    const x = radiusM * Math.sin(th)
    const y = radiusM * (1 - Math.cos(th))
    out.push([-120 + x * DEG_PER_M_LAT * lonScale, lat + y * DEG_PER_M_LAT])
  }
  return out
}

const join = (...tracks: Track[]): Track => {
  // Shift each following track so it starts where the previous ended, which is
  // all these fixtures need — the metric only ever looks at bearing change.
  const out: Track = [...tracks[0]]
  for (let i = 1; i < tracks.length; i++) {
    const at = out[out.length - 1]
    const from = tracks[i][0]
    for (const p of tracks[i].slice(1)) out.push([p[0] - from[0] + at[0], p[1] - from[1] + at[1]])
  }
  return out
}

describe('a straight road', () => {
  it('scores essentially zero', () => {
    // Not exactly zero: the fixture is a rhumb line, so its true bearing drifts
    // slightly. The deadband is what keeps that from accumulating.
    expect(twistiness(straight(50000))!.dpm).toBeLessThan(5)
  })

  it('does not accumulate over distance, which is the whole point of the deadband', () => {
    const short = twistiness(straight(10000))!.dpm
    const long = twistiness(straight(100000))!.dpm
    expect(Math.abs(long - short)).toBeLessThan(5)
  })
})

describe('a curve', () => {
  // A circular arc turns 1 radian per radius-length, so degrees per mile is
  // 1609.344 * (180/pi) / R. Tighter radius, bigger number, linearly.
  const expected = (radiusM: number) => (1609.344 * (180 / Math.PI)) / radiusM

  it('scores in proportion to how tight it is, sweepers included', () => {
    // 800m is the case the original 5° deadband got wrong: it scored 0 because
    // a 25m chord across an 800m curve bends by only 1.8°. Anything that
    // reintroduces a magnitude deadband above ~1.8° will fail here, which is
    // exactly what this assertion is for.
    for (const r of [200, 400, 800]) {
      const got = twistiness(arc(r, 180))!.dpm
      expect(got).toBeGreaterThan(expected(r) * 0.85)
      expect(got).toBeLessThan(expected(r) * 1.15)
    }
  })

  it('ranks a tighter radius above a looser one', () => {
    expect(twistiness(arc(100, 180))!.dpm).toBeGreaterThan(twistiness(arc(500, 180))!.dpm)
  })
})

describe('the best stretch', () => {
  it('finds a twisty section buried in a long boring day', () => {
    // 40km of switchbacks, then 200km of interstate. The average is dragged
    // down; the window is not. The twisty part has to be at least a window long
    // or the window averages the slab back in — which is the whole reason the
    // window is 20 miles rather than 5.
    const day = join(arc(300, 7600, 10), straight(200000))
    const t = twistiness(day)!
    expect(t.bestDpm).toBeGreaterThan(t.dpm * 3)
  })

  it('equals the average when the whole day is uniform', () => {
    const t = twistiness(arc(300, 360))!
    expect(Math.abs(t.bestDpm - t.dpm)).toBeLessThan(t.dpm * 0.35)
  })

  it('reports the length it actually measured, capped at the window', () => {
    // 100km is longer than the 20-mile window, so it reports the window.
    expect(twistiness(straight(100000))!.bestMiles).toBeCloseTo(20, 1)
    // A day shorter than the window measures the whole day and says so.
    expect(twistiness(arc(200, 90))!.bestMiles).toBeLessThan(20)
  })
})

describe('nothing to measure', () => {
  it('is null rather than zero, which would claim the road is straight', () => {
    expect(twistiness([])).toBeNull()
    expect(twistiness([[-120, 37]])).toBeNull()
    expect(twistiness([[-120, 37], [-119, 37]])).toBeNull()
  })

  it('survives a track of repeated identical points', () => {
    const same: Track = Array.from({ length: 50 }, () => [-120, 37] as [number, number])
    expect(twistiness(same)).toBeNull()
  })
})

describe('labels', () => {
  it('names each band at its own floor', () => {
    expect(twistLabel(0)).toBe('Straight')
    expect(twistLabel(39)).toBe('Straight')
    expect(twistLabel(40)).toBe('Mostly straight')
    expect(twistLabel(90)).toBe('Some curves')
    expect(twistLabel(150)).toBe('Twisty')
    expect(twistLabel(240)).toBe('Very twisty')
    expect(twistLabel(9999)).toBe('Very twisty')
  })

  it('says nothing at all when there is no figure', () => {
    expect(twistLabel(null)).toBeNull()
    expect(twistLabel(undefined)).toBeNull()
  })

  it('is ordered high to low, which the lookup depends on', () => {
    const mins = TWIST_BANDS.map((b) => b.min)
    expect(mins).toEqual([...mins].sort((a, b) => b - a))
  })
})
