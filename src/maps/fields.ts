// The scalar fields every ride-shaped request shares, in one place.
//
// Used by the upload form, the ride payload, and PATCH, so a rule stated here
// is the rule everywhere — an external_url that is http(s)-only in one place
// and anything-goes in another is how a javascript: URL gets stored.
//
// Its own module because both routes/maps.ts and maps/ride-graph.ts need it and
// routes/builder.ts imports from routes/maps.ts, so keeping it there would make a
// cycle the moment the importer reused the ride payload.
import { z } from 'zod'
import { visibilityEnum } from '../db/schema'

// Scalar form fields, shared by import (with defaults), PATCH here, and the
// ride API. external_url: http(s) only — never javascript:, never data:.
const externalUrl = z.union([z.literal(''), z.url({ protocol: /^https?$/ }).max(2048)])
export const fields = {
  title: z.string().trim().min(1, 'title is required').max(150),
  description: z.string().trim().max(2000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb'),
  // The four levels, and this is the WRITE gate — until 2026-08-26 it listed
  // three, which is what kept `friends` in the enum and unreachable while the
  // access sweep landed. Read from the enum rather than restated so a fifth
  // level cannot be readable and unwritable for the same reason.
  visibility: z.enum(visibilityEnum.enumValues),
  external_url: externalUrl,
}
/**
 * A zod path as something a rider can act on.
 *
 * **#233.** This returned the raw path, so a builder save that failed came back
 * as `days.1: a day needs at least one stop` — and the panel's readout is a
 * fixed box that ellipsized it to "days.1: a day n…". Two problems in one
 * string: an ARRAY INDEX a rider has no way to count to (day 1 is the second
 * day, and alternates and subgroups make "the second day" ambiguous anyway), and
 * a shape that reads as a stack trace rather than as something to fix.
 *
 * Days and points are numbered from 1 because that is how they are labelled on
 * screen. Anything else keeps its own name, since every other path segment here
 * is a real field a rider typed into — `title`, `visibility`, `external_url`.
 */
const humanPath = (path: PropertyKey[]): string => {
  const parts: string[] = []
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]
    const next = path[i + 1]
    if (seg === 'days' && typeof next === 'number') {
      parts.push(`day ${next + 1}`)
      i++
    } else if ((seg === 'points' || seg === 'legs') && typeof next === 'number') {
      parts.push(`${seg === 'points' ? 'point' : 'leg'} ${next + 1}`)
      i++
    } else if (typeof seg === 'number') {
      // A bare index with no container name in front of it. Rare, and 1-based
      // for the same reason as the two above.
      parts.push(`#${seg + 1}`)
    } else {
      parts.push(String(seg))
    }
  }
  return parts.join(', ')
}

export const firstIssue = (e: z.ZodError): string => {
  const i = e.issues[0]
  return i.path.length ? `${humanPath(i.path as PropertyKey[])}: ${i.message}` : i.message
}
