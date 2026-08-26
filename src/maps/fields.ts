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
export const firstIssue = (e: z.ZodError): string => {
  const i = e.issues[0]
  return i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message
}
