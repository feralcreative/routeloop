// set_trip_brief (#456): what the assistant learns about the riders, kept on the ride.
//
// IT WRITES THE DATABASE DIRECTLY, NOT THE RIDE. The brief lives in its own table so
// a builder's whole-ride save can never wipe it (src/db/schema.ts), so this is not an
// edit to the draft: there is nothing to roll back, nothing for the builder to apply,
// and over MCP nothing to propose. `writes` says so on the capability, which is what
// keeps the MCP annotations from calling it read-only.
//
// THE PLANNERS' CALL: edit standing, the same trust as moving a stop.
import { z } from 'zod'
import { EXPERIENCE, FREEWAY, GRAVEL, LODGING, PACE, briefLines, mergeBrief, type BriefEdit } from '../../briefs/policy'
import { updateBrief } from '../../briefs/service'
import { METERS_PER_MILE } from '../../maps/kml'
import { quoted } from '../summary'
import type { AgentContext, Tool } from '../tools'

const tool = <S extends z.ZodObject>(t: Tool<S>) => t
const txt = (max: number) => z.string().max(max).nullable().optional()

/** The brief as the assistant reads it, every rider-written value quoted. */
export function briefText(ctx: AgentContext): string {
  const b = ctx.brief
  if (!b) return 'No trip brief: nothing is known about how these riders like to ride. Ask, then record it with set_trip_brief.'
  const lines = briefLines(b, ctx.units)
  if (!lines.length) return 'The trip brief is empty: ask how these riders like to ride, then record it with set_trip_brief.'
  const free = new Set(['Load', 'Weather limits', 'Budget', 'Flexibility', 'If something goes wrong', 'Notes'])
  return ['Trip brief (what the planners said about these riders):', ...lines.map((l) => `- ${l.label}: ${free.has(l.label) ? quoted(l.value) : l.value}`)].join('\n')
}

export const setTripBrief = tool({
  name: 'set_trip_brief',
  cap: { mutates: false, writes: true, needs: 'edit' },
  description:
    'Record what you learned about how these riders like to ride, on the ride itself, so every later conversation and check_ride knows it. Only record what the rider told you; never guess. A field you leave out keeps its value; null clears it. Lengths are in the rider’s units. It saves at once (it is not a ride edit, so nothing needs applying).',
  schema: z
    .object({
      experience: z.enum(EXPERIENCE).nullable().optional(),
      hours_per_day: z.number().min(1).max(16).nullable().optional(),
      // 1,200 fits the stored ceiling of 2,000 km in either unit (1,200 mi is 1,931 km).
      longest_day: z.number().min(1).max(1200).nullable().optional(),
      pace: z.enum(PACE).nullable().optional(),
      gravel: z.enum(GRAVEL).nullable().optional(),
      freeway: z.enum(FREEWAY).nullable().optional(),
      load: txt(200),
      weather: txt(300),
      lodging: z.enum(LODGING).nullable().optional(),
      budget: txt(200),
      flexibility: txt(300),
      contingencies: txt(300),
      notes: txt(1000),
    })
    .strict(),
  run: async (ctx, input) => {
    if (ctx.rideId == null || ctx.userId == null || ctx.brief === undefined)
      return 'This ride is not saved yet, so there is nowhere to keep a brief. Save it first.'
    const perUnit = ctx.units === 'km' ? 1000 : METERS_PER_MILE
    const { hours_per_day, longest_day, ...rest } = input
    const edit: BriefEdit = {
      ...rest,
      ...(hours_per_day !== undefined ? { hoursPerDay: hours_per_day } : {}),
      ...(longest_day !== undefined ? { dayM: longest_day == null ? null : Math.round(longest_day * perUnit) } : {}),
    }
    // Checked here so a bad value is the model's error to fix, not a server error.
    mergeBrief(ctx.brief, edit)
    ctx.brief = await updateBrief(ctx.rideId, ctx.userId, edit)
    return `Saved.\n${briefText(ctx)}`
  },
})
