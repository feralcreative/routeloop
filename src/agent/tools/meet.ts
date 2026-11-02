// propose_meeting_points: the Groups panel's Find meeting points, for the assistant
// (#439).
//
// THE SAME PRESS, NOT A SECOND IDEA OF ONE. proposeMeetingPoints() in
// src/subgroups/propose.ts is what the builder's button calls through
// POST /api/rides/:id/rendezvous; this hands it the ride in ctx (the builder's open
// copy, or the saved one over MCP) instead of the stored rows, so the assistant reads
// the answer the panel would draw for the ride the rider is looking at.
//
// IT PROPOSES AND NOTHING ELSE. Choosing a meeting point adds it to the main group's
// route and to that one joining group's (the others stay undecided), sets the joining
// group's departure so both arrive together, and cuts the shared stretch; that is the
// panel's job (takeMeet() in builder.js), done by the rider pressing a candidate. The tool says so in every answer, so the model cannot claim to have
// placed one.
//
// IT SPENDS REAL GOOGLE MONEY, and every Places and Routes request goes through
// ctx.budget: the service takes the budget before each billed request and refunds a
// cached one. A request the budget refuses is never made, and the answer names the
// group it left short instead of reading as a road with nothing on it.
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../../db/index'
import { userProfiles } from '../../db/schema'
import { clampDivert, DEFAULT_DIVERT_MI, fuelRoleOf } from '../../subgroups/rendezvous'
import {
  ANCHOR_BUDGET,
  MEET_LIMIT,
  proposeMeetingPoints,
  ROUTED_BUDGET,
  type GroupAnswer,
} from '../../subgroups/propose'
import { METERS_PER_MILE } from '../../maps/kml'
import { TURN_LIMITS } from '../policy'
import { quoted, type Units } from '../summary'
import type { Tool } from '../tools'

const tool = <S extends z.ZodObject>(t: Tool<S>) => t

/**
 * The most Text Searches one call makes: the press's whole station allowance,
 * ANCHOR_BUDGET, which is also a whole turn's. A ride with more than six joining
 * groups would spend one more per group (the floor of one anchor each); the call's
 * ceiling stops it at six, and every group past that is told it was not searched.
 */
export const MEET_MAX_SEARCHES = Math.min(ANCHOR_BUDGET, TURN_LIMITS.placeSearches)

/**
 * The most Routes requests one call makes: ROUTED_BUDGET's twelve approaches, plus
 * one direct road for each start-only joining group, for as many groups as the
 * search allowance serves (six). That is the whole bill of any ride with six or
 * fewer joining groups, and it leaves twelve of a turn's thirty for edits. A bigger
 * ride is cut off by the ceiling and the groups it reached last are told so.
 */
export const MEET_MAX_LEGS = Math.min(ROUTED_BUDGET + ANCHOR_BUDGET, TURN_LIMITS.legRoutings)

const KM_PER_MI = METERS_PER_MILE / 1000

/** A rounded mile figure from the service, in the rider's units. */
const extra = (mi: number, u: Units) => (u === 'mi' ? `${mi.toFixed(1)} mi` : `${(mi * KM_PER_MI).toFixed(1)} km`)
const along = (m: number, u: Units) => `${Math.round(u === 'mi' ? m / METERS_PER_MILE : m / 1000)} ${u}`

/** The rider's own extra-detour preference from /settings, or undefined. */
async function divertPreference(userId: number | undefined): Promise<number | undefined> {
  if (userId == null) return undefined
  const [p] = await db
    .select({ meetDivertMi: userProfiles.meetDivertMi })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1)
  return clampDivert(p?.meetDivertMi)
}

function groupLines(a: GroupAnswer, u: Units, station: string, capMi: number): string[] {
  const p = a.proposal
  const out = [`Group ${quoted(p.name, 'Unnamed')} [${p.group}]:`]
  if (p.candidates.length === 0) {
    out.push(
      a.legLimited || a.searchLimited
        ? '  No candidates, and the budget for this turn (or today) ran out before this group was fully measured, so nothing is known. Do not tell the rider there is nowhere to meet.'
        : `  No viable meeting point on the main group’s road for this group: within the ${extra(capMi, u)} extra-detour allowance, every point either leaves too little road to ride together or asks them to double back. A larger allowance (max_detour_mi) helps only with the first.`,
    )
    return out
  }
  p.candidates.forEach((c, i) => {
    const d = c.diverts.find((x) => x.group === p.group)
    const what = c.isFuel
      ? `${quoted(c.name, `a ${station}`)}${c.address ? `, ${quoted(c.address)}` : ''} · a ${station}, a fuel stop`
      : 'a point on the road, not a fuel stop'
    const detour = d
      ? d.onRoute
        ? 'on their own way, no detour'
        : d.mi === 0
          ? 'their shortest way to join'
          : `${extra(d.mi, u)} extra detour beyond their shortest way to join`
      : 'detour unknown'
    out.push(
      `  ${i + 1}. ${what} (lat ${c.lat.toFixed(6)}, lng ${c.lng.toFixed(6)}) · ${detour} · about ${along(c.alongM, u)} along the main group’s road`,
    )
  })
  if (a.searchLimited)
    out.push(
      `  The search budget for this turn (or today) ran out before every ${station} search for this group ran, so a ${station} may be near that was never looked for. Do not say there is none.`,
    )
  else if (p.note === 'no-gas')
    out.push(`  Note: no ${station} was found where a meet works, so these are points on the road.`)
  if (a.legLimited)
    out.push(
      '  The routing budget for this turn (or today) ran out before every approach was measured by road, so some detours are straight-line estimates and whether the group can reach a candidate on one tank was not checked for all of them.',
    )
  else if (p.note === 'out-of-range')
    out.push(
      `  Note: ${station}s were found, but none within one tank of every group’s last fill, so the group may need to refuel before meeting.`,
    )
  return out
}

export const proposeMeetingPointsTool = tool({
  name: 'propose_meeting_points',
  cap: { mutates: false, needs: 'edit', spends: { search: MEET_MAX_SEARCHES, leg: MEET_MAX_LEGS } },
  description: `Where each joining group could meet the main group, the way the Groups panel’s Find meeting points does: candidates on the main group’s road, preferring a gas station (a charger on an electric ride) within one tank of every group, ranked by the extra road distance each group rides beyond its shortest way to join. Returns up to ${MEET_LIMIT} per joining group, with each one’s extra detour and whether it is a fuel stop. PROPOSES ONLY: you cannot place a meeting point. To use one, the rider presses Find meeting points in the builder’s Groups panel and picks it there, which adds it to the main group’s route and that joining group’s, and sets that group’s departure so both arrive together. Needs two or more groups and a drawn road for the main group. Uses up to ${MEET_MAX_SEARCHES} place searches and ${MEET_MAX_LEGS} routed legs.`,
  schema: z
    .object({
      max_detour_mi: z
        .number()
        .min(1)
        .max(200)
        .optional()
        .describe(
          `How much further than its shortest way to join a group may be sent, in miles; default the rider’s own setting, else ${DEFAULT_DIVERT_MI}`,
        ),
    })
    .strict(),
  run: async (ctx, input) => {
    const u = ctx.units
    // ctx.fuel is the surfaces' answer, the one the map uses. Absent (tests, evals), the
    // ride's own vehicle and power decide it, with the rider's preset behind them.
    const role = ctx.fuel
      ? ctx.fuel.role
      : fuelRoleOf({
          ridePower: ctx.ride.power,
          rideVehicle: ctx.ride.vehicle,
          profilePower: ctx.preset?.power,
          profileVehicle: ctx.preset?.vehicle,
        })
    const station = role === 'charge' ? 'charger' : 'gas station'
    const maxDivertMi = clampDivert(input.max_detour_mi) ?? (await divertPreference(ctx.userId))
    const capMi = maxDivertMi ?? DEFAULT_DIVERT_MI

    ctx.progress('Finding meeting points')
    const out = await proposeMeetingPoints(ctx.ride, {
      fuel: async () => ({
        role,
        rangeMi: ctx.fuel?.rangeM != null ? ctx.fuel.rangeM / METERS_PER_MILE : null,
      }),
      maxDivertMi,
      favor: ctx.favor,
      avoid: ctx.avoid,
      budget: ctx.budget,
    })

    if (!out.ok) {
      if (out.reason === 'one-group')
        return 'This ride has one group, so there is nobody to meet. Meeting points are for a ride with two or more groups setting off from different places; groups are added in the builder’s Groups panel.'
      return out.group !== undefined
        ? `The main group ${quoted(out.group)} has no road drawn yet, and a meeting point is placed on the main group’s road. Draw their route first.`
        : 'There is nothing to propose yet: either the main group has no route at all, or no other group has a route with a starting point. The main group needs its road, and each joining group a route of its own or at least a starting point.'
    }

    const lines = [
      `Meeting points on the road of the main group ${quoted(out.mainGroup)}, one list per joining group, best first, within an extra detour of ${extra(capMi, u)}.`,
    ]
    if (role && ctx.fuel?.rangeM == null)
      lines.push('Nobody on the ride has a fuel range on file, so no candidate was checked against a tank.')
    for (const g of out.groups) lines.push(...groupLines(g, u, station, capMi))
    lines.push(
      'These are proposals only; nothing was added to the ride. To use one, the rider presses Find meeting points in the builder’s Groups panel and picks it there, which adds it to the main group’s route and that joining group’s, and sets that group’s departure so both arrive together. Each joining group is decided on its own.',
    )
    return lines.join('\n')
  },
})
