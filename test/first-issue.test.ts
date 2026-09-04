// How a validation failure is worded (#233).
//
// This is not cosmetic. The builder's save readout is a fixed box that
// ellipsizes, so what a rider actually saw of `days.1: a day needs at least one
// stop` was "days.1: a day n…" — reported as "a Costco sample of an error
// message". The dialog now carries the whole string, and this decides whether
// the whole string is worth reading.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { firstIssue } from '../src/maps/fields'

/** The first issue from parsing `value` against `schema`. */
const issue = (schema: z.ZodType, value: unknown): string => {
  const r = schema.safeParse(value)
  if (r.success) throw new Error('expected a failure')
  return firstIssue(r.error)
}

const daysSchema = z.object({
  days: z.array(
    z.object({
      title: z.string(),
      points: z.array(z.object({ name: z.string() })).min(1, 'a day needs at least one stop'),
    }),
  ),
})

describe('naming where a save failed', () => {
  // THE CASE FROM THE REPORT. `days.1` is an array index a rider has no way to
  // count to — and with alternates and subgroups in the list, "the second day"
  // is not even a thing they can point at reliably.
  it('numbers a day from one, as the screen does', () => {
    const bad = { days: [{ title: 'Friday', points: [{ name: 'a' }] }, { title: 'Friday', points: [] }] }
    expect(issue(daysSchema, bad)).toBe('day 2, points: a day needs at least one stop')
  })

  it('numbers a point inside a day the same way', () => {
    const bad = { days: [{ title: 'Friday', points: [{ name: 'a' }, { name: 42 }] }] }
    // The field is named too, which is the point of keeping every other segment
    // as it is: "point 2, name" says where AND what.
    expect(issue(daysSchema, bad)).toMatch(/^day 1, point 2, name: /)
  })

  // Every other segment is a field a rider typed into, so it keeps its own name.
  it('leaves a plain field name alone', () => {
    const schema = z.object({ title: z.string().min(1, 'title is required') })
    expect(issue(schema, { title: '' })).toBe('title: title is required')
  })

  it('says only the message when there is no path at all', () => {
    const schema = z.string().min(3, 'too short')
    expect(issue(schema, 'x')).toBe('too short')
  })

  it('handles a nested day path end to end', () => {
    const schema = z.object({
      days: z.array(z.object({ legs: z.array(z.object({ distanceM: z.number() })) })),
    })
    const bad = { days: [{ legs: [] }, { legs: [{ distanceM: 'no' }] }] }
    expect(issue(schema, bad)).toMatch(/^day 2, leg 1, distanceM: /)
  })
})
