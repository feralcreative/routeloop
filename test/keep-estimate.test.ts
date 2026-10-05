import { describe, expect, it } from 'vitest'
import { keepEstimateBytes } from '../src/rides/keep-estimate'

describe('keepEstimateBytes', () => {
  it('lands near the measured 13-route, 63,765-point ride (about 3.2 MB kept)', () => {
    const est = keepEstimateBytes(63_765, 13)
    expect(est).toBeGreaterThan(3_000_000)
    expect(est).toBeLessThan(3_500_000)
  })

  it('never goes below the base or turns NaN on junk', () => {
    expect(keepEstimateBytes(0, 0)).toBe(20_000)
    expect(keepEstimateBytes(Number.NaN, -3)).toBe(20_000)
  })
})
