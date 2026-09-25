// The jargon table (#321): precedence, the pluralizer, and coverage.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { jargonCsv } from '../utils/build-jargon-csv'
import {
  DEFAULT_VOCAB,
  TERMS,
  TERM_IDS,
  VEHICLES,
  POWERS,
  aWd,
  customWord,
  exampleParts,
  toJargon,
  toPower,
  toVehicle,
  wordsFor,
} from '../src/views/vocab'

describe('vocab', () => {
  it('has a word for every preset on every preset-bound term', () => {
    for (const t of TERMS) {
      if (t.axis === 'vehicle') for (const v of VEHICLES) expect(t.by[v], `${t.id}/${v}`).toBeDefined()
      if (t.axis === 'power')
        for (const p of ['gas', 'electric'] as const) expect(t.by[p], `${t.id}/${p}`).toBeDefined()
      if (t.axis === 'regional') expect(t.options?.length).toBeGreaterThan(1)
    }
    expect(TERMS.map((t) => t.id)).toEqual([...TERM_IDS])
  })

  it('coerces the pair, and a bicycle never runs on gas', () => {
    expect(toVehicle('lorry')).toBe('motorcycle')
    expect(toPower('gas', 'bicycle')).toBe('pedal')
    expect(toPower('pedal', 'car')).toBe('gas')
    expect(toPower('electric', 'bicycle')).toBe('electric')
    expect(toPower(undefined, 'motorcycle')).toBe('gas')
  })

  it('the ride picks the preset', () => {
    const car = wordsFor(DEFAULT_VOCAB, { vehicle: 'car', power: 'electric' })
    expect(car.journey?.one).toBe('trip')
    expect(car.fuel?.one).toBe('charge')
    expect(car.tank?.many).toBe('batteries')
    // A ride with no preset of its own is the rider's default.
    expect(wordsFor({ ...DEFAULT_VOCAB, vehicle: 'car' }, { vehicle: null, power: null }).journey?.one).toBe('trip')
    // A ride naming only a vehicle takes the rider's power, coerced to it.
    expect(wordsFor(DEFAULT_VOCAB, { vehicle: 'bicycle' }).fuel).toBeNull()
  })

  it("a rider's Custom word overrides the ride's preset, except under pedal", () => {
    const me = { ...DEFAULT_VOCAB, jargon: { journey: 'adventure', fuel: 'juice' } }
    const onCar = wordsFor(me, { vehicle: 'car', power: 'gas' })
    expect(onCar.journey).toEqual({ one: 'adventure', many: 'adventures' })
    expect(onCar.fuel?.one).toBe('juice')
    expect(onCar.person?.one).toBe('driver')
    expect(wordsFor(me, { vehicle: 'bicycle', power: 'pedal' }).fuel).toBeNull()
  })

  it('puts the right article in front', () => {
    const w = wordsFor({ ...DEFAULT_VOCAB, jargon: { journey: 'adventure', roadbook: 'itinerary' } })
    expect(aWd(w, 'journey')).toBe('an adventure')
    expect(aWd(w, 'roadbook')).toBe('an itinerary')
    expect(aWd(w, 'person')).toBe('a rider')
  })

  it('pluralizes typed words with +s, or a slash', () => {
    expect(customWord('trip')).toEqual({ one: 'trip', many: 'trips' })
    expect(customWord('person/people')).toEqual({ one: 'person', many: 'people' })
    expect(customWord('gas/')).toEqual({ one: 'gas', many: 'gas' })
  })

  it('drops what it does not know and never throws', () => {
    expect(toJargon(null)).toEqual({})
    expect(toJargon({ journey: '  Adventure ', bogus: 'x', fuel: '', tank: 7 })).toEqual({ journey: 'adventure' })
    expect(toJargon({ journey: 'x'.repeat(80) }).journey).toHaveLength(40)
  })

  it('matches docs/jargon.csv, the readable copy of the table', () => {
    // Regenerate with `npx tsx utils/build-jargon-csv.ts` when the table changes.
    expect(readFileSync('docs/jargon.csv', 'utf8')).toBe(jargonCsv())
  })

  it('power terms mirror POWERS minus pedal', () => {
    expect(POWERS).toContain('pedal')
    for (const t of TERMS) if (t.axis === 'power') expect(t.by.pedal).toBeUndefined()
  })
})

describe('the settings examples read with the word in force', () => {
  it('gives every term a slot for its word', () => {
    for (const t of TERMS) expect(t.where, t.id).toMatch(/\{(one|many|One|Many)\}/)
  })

  it('fills the slots, capitalized where the template asks', () => {
    const parts = exampleParts('“Plan a {one}”, the {Many} tab', { one: 'fart', many: 'farts' })
    expect(parts.map((p) => p.text).join('')).toBe('“Plan a fart”, the Farts tab')
    expect(parts.filter((p) => p.slot).map((p) => p.text)).toEqual(['fart', 'Farts'])
  })
})
