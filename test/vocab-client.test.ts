// public/js/vocab.js against src/views/vocab.ts: the same words, every preset,
// with and without a rider's own words. The twist-client arrangement.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { DEFAULT_VOCAB, POWERS, TERMS, VEHICLES, customWord, wordsFor, type Vocab } from '../src/views/vocab'

const win: Record<string, unknown> = {}
new Function('window', readFileSync('public/js/vocab.js', 'utf8'))(win)
const client = win.TBVocab as {
  resolve: (terms: unknown, profile: Vocab, ride: unknown) => Record<string, unknown>
  customWord: (s: string) => unknown
}

// The shape page() emits: the table minus its labels.
const terms = TERMS.map((t) => ({ id: t.id, axis: t.axis, by: t.by, options: t.options }))

describe('vocab.js', () => {
  it('agrees with wordsFor across every preset and both layers', () => {
    const profiles: Vocab[] = [
      DEFAULT_VOCAB,
      { vehicle: 'car', power: 'electric', jargon: { journey: 'adventure', fuel: 'juice', highway: 'motorway' } },
      { vehicle: 'bicycle', power: 'pedal', jargon: { person: 'person/people' } },
    ]
    for (const profile of profiles) {
      expect(client.resolve(terms, profile, null)).toEqual(wordsFor(profile, null))
      for (const vehicle of VEHICLES)
        for (const power of POWERS) {
          expect(client.resolve(terms, profile, { vehicle, power })).toEqual(wordsFor(profile, { vehicle, power }))
          expect(client.resolve(terms, profile, { vehicle, power: null })).toEqual(wordsFor(profile, { vehicle }))
        }
    }
  })

  it('pluralizes the same way', () => {
    for (const s of ['trip', 'person/people', 'gas/', 'cue sheet']) expect(client.customWord(s)).toEqual(customWord(s))
  })
})
