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

// Scalar form fields, shared by import (with defaults), PATCH here, and the
// ride API. external_url: http(s) only — never javascript:, never data:.
const externalUrl = z.union([z.literal(''), z.url({ protocol: /^https?$/ }).max(2048)])
export const fields = {
  title: z.string().trim().min(1, 'title is required').max(150),
  description: z.string().trim().max(2000),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'color must be #rrggbb'),
  visibility: z.enum(['public', 'unlisted', 'private']),
  external_url: externalUrl,
}
export const firstIssue = (e: z.ZodError): string => {
  const i = e.issues[0]
  return i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message
}
