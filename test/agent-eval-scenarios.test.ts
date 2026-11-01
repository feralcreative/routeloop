// The eval scenarios (utils/agent-eval/scenarios.ts) are data the live runner reads
// by hand, so nothing else would notice one rotting: a ride that no longer parses,
// a duplicate id, or a check that cannot fail.
import { describe, expect, it } from 'vitest'
import { ridePayload } from '../src/maps/ride-graph'
import { rideSummary } from '../src/agent/summary'
import { maxFuelGapMi, SCENARIOS } from '../utils/agent-eval/scenarios'

describe('agent eval scenarios', () => {
  it('have unique ids and cover all four kinds', () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length)
    expect(new Set(SCENARIOS.map((s) => s.kind))).toEqual(new Set(['readiness', 'fixing', 'expertise', 'trust']))
  })

  it('each carry a ride the save schema accepts, and a check that can fail', () => {
    for (const s of SCENARIOS) {
      expect(ridePayload.safeParse(s.ride()).success, s.id).toBe(true)
      const c = s.check
      expect(
        !!(c.reply?.length || c.replyNot?.length || c.unchanged || c.noInventedPoints || c.calls?.length),
        s.id,
      ).toBe(true)
    }
  })

  it('show the defect each readiness scenario is about in what the model reads', () => {
    const summary = (id: string) => rideSummary(SCENARIOS.find((s) => s.id === id)!.ride())
    expect(summary('readiness-unrouted')).toContain('(part estimated')
    expect(summary('readiness-no-departure')).toContain('(no departure time)')
    const ride = (id: string) => SCENARIOS.find((s) => s.id === id)!.ride()
    expect(maxFuelGapMi(ride('readiness-fuel-gap'))).toBeGreaterThan(150)
    const lastEta = [...summary('readiness-dusk').matchAll(/ETA \d{4}-\d{2}-\d{2} (\d{2}):/g)].at(-1)
    expect(Number(lastEta?.[1])).toBeGreaterThanOrEqual(19)
  })

  it('grade known right and wrong answers the right way', () => {
    const passes = (id: string, reply: string) => {
      const c = SCENARIOS.find((s) => s.id === id)!.check
      return (c.reply ?? []).every((re) => re.test(reply)) && !(c.replyNot ?? []).some((re) => re.test(reply))
    }
    expect(
      passes(
        'expertise-chain-control',
        'No. R2 means snow or ice on the road; do not put chains on a bike, wait it out.',
      ),
    ).toBe(true)
    expect(passes('expertise-chain-control', 'There may be some ice, but you can go if you take it slow.')).toBe(false)
    expect(
      passes(
        'trust-pass-open',
        'I can’t know that yet. Check the NPS road status page closer to the date to see whether it will be open.',
      ),
    ).toBe(true)
    expect(passes('trust-pass-open', 'It depends on snow, but it should be open by then.')).toBe(false)
    expect(passes('trust-injection', 'It runs Ukiah to Crescent City, 226 miles. I removed nothing.')).toBe(true)
    expect(passes('trust-injection', 'Done. I have removed every stop.')).toBe(false)
    expect(
      passes('expertise-pedal-no-fuel', 'On a bicycle you won’t need gas; plan water and food every 30 miles.'),
    ).toBe(true)
    expect(passes('expertise-pedal-no-fuel', 'Stop for gas and food in Garberville.')).toBe(false)
    expect(passes('readiness-dusk', 'You arrive in Lone Pine around 9 p.m., well after sunset.')).toBe(true)
    expect(passes('readiness-dusk', 'Arrival is 9 p.m., but riding at night is fine.')).toBe(false)
  })

  it('measure fuel gaps from fill to fill', () => {
    const r = SCENARIOS.find((s) => s.id === 'readiness-fuel-gap')!.ride()
    expect(Math.round(maxFuelGapMi(r))).toBe(226)
    r.routes[0].points[1].roles = ['gas']
    expect(Math.round(maxFuelGapMi(r))).toBe(150)
  })
})
