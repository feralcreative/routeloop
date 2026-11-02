// The trip brief (#456): what it holds, how an edit merges into it, and how it reads.
// Pure; `service.ts` is the only reader and writer of `ride_briefs`.
//
// A FIELD LEFT OUT IS UNKNOWN, NEVER A DEFAULT. Every field is optional, and the
// assistant is told to ask rather than assume, so an absent pace is "nobody said",
// which is a different answer from "steady".
//
// LENGTHS ARE METERS, the rest of the app's storage rule; the tool takes miles or
// kilometers by the rider's units and converts at the door.
import { z } from 'zod'
import { METERS_PER_MILE } from '../maps/kml'

const text = (max: number) => z.string().trim().max(max)

export const EXPERIENCE = ['new', 'some', 'seasoned'] as const
export const PACE = ['relaxed', 'steady', 'brisk'] as const
export const GRAVEL = ['none', 'some', 'happy'] as const
export const FREEWAY = ['avoid', 'ok', 'prefer'] as const
export const LODGING = ['beds', 'camping', 'mix'] as const

export const briefSchema = z
  .object({
    experience: z.enum(EXPERIENCE),
    /** Comfortable riding hours in a day, stops not counted. */
    hoursPerDay: z.number().min(1).max(16),
    /** The longest day they want, in meters. */
    dayM: z.number().min(1_000).max(2_000_000),
    pace: z.enum(PACE),
    gravel: z.enum(GRAVEL),
    freeway: z.enum(FREEWAY),
    /** Two-up, loaded for camping, light: in their words. */
    load: text(200),
    /** What weather they will and will not ride in. */
    weather: text(300),
    lodging: z.enum(LODGING),
    budget: text(200),
    /** How fixed the dates and the route are. */
    flexibility: text(300),
    /** What they want to do when something goes wrong. */
    contingencies: text(300),
    notes: text(1000),
  })
  .partial()
  .strict()

export type Brief = z.infer<typeof briefSchema>
export const BRIEF_FIELDS = Object.keys(briefSchema.shape) as (keyof Brief)[]

/** An edit: a value sets a field, null clears it, a field left out keeps its value. */
export type BriefEdit = { [K in keyof Brief]?: Brief[K] | null }

export function mergeBrief(current: Brief, edit: BriefEdit): Brief {
  const out: Record<string, unknown> = { ...current }
  for (const [k, v] of Object.entries(edit)) {
    if (v === undefined) continue
    // Whitespace is nothing said: trimmed here, before the empty test, or "   " would
    // store an empty string and the brief would read as written.
    if (v === null || (typeof v === 'string' && v.trim() === '')) delete out[k]
    else out[k] = v
  }
  return briefSchema.parse(out)
}

/** A stored brief, read leniently: a field that no longer validates is dropped
 *  rather than losing the rest, because the shape will move and old rows stay. */
export function readBrief(raw: unknown): Brief {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, unknown> = {}
  for (const k of BRIEF_FIELDS) {
    const one = briefSchema.shape[k].safeParse((raw as Record<string, unknown>)[k])
    if (one.success && one.data !== undefined) out[k] = one.data
  }
  return out as Brief
}

export const isEmptyBrief = (b: Brief) => BRIEF_FIELDS.every((k) => b[k] === undefined)

export const lengthOf = (m: number, units: 'mi' | 'km') =>
  units === 'km' ? `${Math.round(m / 1000)} km` : `${Math.round(m / METERS_PER_MILE)} mi`

const LABELS: Record<keyof Brief, string> = {
  experience: 'Experience',
  hoursPerDay: 'Riding hours a day',
  dayM: 'Longest day',
  pace: 'Pace',
  gravel: 'Gravel and dirt',
  freeway: 'Freeways',
  load: 'Load',
  weather: 'Weather limits',
  lodging: 'Beds or camping',
  budget: 'Budget',
  flexibility: 'Flexibility',
  contingencies: 'If something goes wrong',
  notes: 'Notes',
}

const WORDS: Partial<Record<keyof Brief, Record<string, string>>> = {
  experience: { new: 'new to long trips', some: 'some long trips', seasoned: 'seasoned' },
  pace: { relaxed: 'relaxed', steady: 'steady', brisk: 'brisk' },
  gravel: { none: 'pavement only', some: 'a little is fine', happy: 'happy on it' },
  freeway: { avoid: 'avoid them', ok: 'fine when it helps', prefer: 'prefer them' },
  lodging: { beds: 'beds', camping: 'camping', mix: 'a mix' },
}

/** The brief as label and value pairs, in field order, for the assistant and the builder. */
export function briefLines(b: Brief, units: 'mi' | 'km'): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = []
  for (const k of BRIEF_FIELDS) {
    const v = b[k]
    if (v === undefined) continue
    const value =
      k === 'dayM'
        ? lengthOf(v as number, units)
        : k === 'hoursPerDay'
          ? `${v} hours`
          : (WORDS[k]?.[v as string] ?? String(v))
    out.push({ label: LABELS[k], value })
  }
  return out
}
