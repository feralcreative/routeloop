// How a validation failure is worded (#233).
//
// This is not cosmetic. The builder's save readout is a fixed box that
// ellipsizes, so what a rider actually saw of `routes.1: a route needs at least one
// stop` was "routes.1: a route n…" — reported as "a Costco sample of an error
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

const routesSchema = z.object({
  routes: z.array(
    z.object({
      title: z.string(),
      points: z.array(z.object({ name: z.string() })).min(1, 'a route needs at least one stop'),
    }),
  ),
})

describe('naming where a save failed', () => {
  // THE CASE FROM THE REPORT. `routes.1` is an array index a rider has no way to
  // count to — and with alternates and subgroups in the list, "the second route"
  // is not even a thing they can point at reliably.
  it('numbers a route from one, as the screen does', () => {
    const bad = {
      routes: [
        { title: 'Friday', points: [{ name: 'a' }] },
        { title: 'Friday', points: [] },
      ],
    }
    expect(issue(routesSchema, bad)).toBe('route 2, points: a route needs at least one stop')
  })

  it('numbers a point inside a route the same way', () => {
    const bad = { routes: [{ title: 'Friday', points: [{ name: 'a' }, { name: 42 }] }] }
    // The field is named too, which is the point of keeping every other segment
    // as it is: "point 2, name" says where AND what.
    expect(issue(routesSchema, bad)).toMatch(/^route 1, point 2, name: /)
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

  it('handles a nested route path end to end', () => {
    const schema = z.object({
      routes: z.array(z.object({ legs: z.array(z.object({ distanceM: z.number() })) })),
    })
    const bad = { routes: [{ legs: [] }, { legs: [{ distanceM: 'no' }] }] }
    expect(issue(schema, bad)).toMatch(/^route 2, leg 1, distanceM: /)
  })
})
