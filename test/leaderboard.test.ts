import { describe, expect, it } from 'vitest'
import { rank, toMetric } from '../src/leaderboard/policy'

describe('the Most Active board (#192)', () => {
  it('reads the metric from the query and falls back to miles', () => {
    expect(toMetric('rides')).toBe('rides')
    expect(toMetric('views')).toBe('miles')
    expect(toMetric(undefined)).toBe('miles')
  })

  it('ranks ties together and skips the next rank', () => {
    const r = rank([{ v: 10 }, { v: 7 }, { v: 7 }, { v: 3 }], (x) => x.v)
    expect(r.map((x) => x.rank)).toEqual([1, 2, 2, 4])
  })
})
