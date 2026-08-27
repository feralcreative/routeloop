// THE CROSS-SUBGROUP SOLVE: given how long each strand takes to ride, when does
// everybody leave.
//
// Pure — arithmetic over minutes, no database and no Date arithmetic beyond
// epoch milliseconds — so it is testable under the house rule that governs
// test/. It is deliberately separate from public/js/ride-time.js, which solves a
// DIFFERENT problem: that walks one day's points and legs to place a moment on
// the map. This places whole strands against each other.
//
// TWO AXES, AND KEEPING THEM APART IS MOST OF THE DESIGN. #67's finding, and
// what dissolves the contradiction #143 was written with:
//
//   WHOSE clock is pinned   the primary subgroup
//   WHICH event is pinned   the anchor: departure, meet, or arrival
//
// "The group farthest away sets the departure AND the main group is pinned at
// 9am" is two anchors, and only one can hold. Naming them separately is what
// makes that visible rather than a bug someone reports six months later.

import type { TimeAnchor } from '../db/schema'

const MIN = 60_000

/** One subgroup's approach, reduced to the only two numbers the solve needs. */
export type Strand = {
  subgroupId: number
  /** Riding time from this strand's own start to the meet, in seconds. Dwell at
   *  its own intermediate stops is included by the caller — this module never
   *  looks inside a day. */
  toMeetS: number
  /** Riding time from the meet to the end of the ride, in seconds. Identical
   *  for every strand on a ride with one trunk, and NOT assumed to be: a ride
   *  can split again afterwards and each strand goes a different way home. */
  fromMeetS: number
}

/** What the meeting point itself costs, read off the meet's own point row. */
export type MeetCost = {
  /**
   * Time EVERYONE spends at the meet — `points.duration_min`. A group that has
   * just converged is talking, fueling and putting gear back on, so the default
   * a builder offers is minutes rather than seconds. It pushes the shared
   * departure later for everybody.
   */
  dwellMin: number
  /**
   * Time only a LATE group spends — `points.slack_min`. Ziad's call,
   * 2026-08-26, after #67 left it open.
   *
   * It is a margin AHEAD of the meet rather than time at it. Every strand is
   * asked to arrive `slackMin` before the moment the group is actually built
   * around, so a group up to that late costs nobody anything.
   *
   * BE PRECISE ABOUT WHAT THIS DOES AND DOES NOT DO, because the obvious claim
   * is wrong and was written into this file's first draft:
   *
   *   IN THE PLANNED SCHEDULE, DWELL AND SLACK SUM. The gap between the last
   *   asked-for arrival and the onward departure is `dwellMin + slackMin`
   *   whichever way it is split, and under the 'departure' and 'arrival'
   *   anchors moving a minute from one to the other changes no time this module
   *   returns. Under the 'meet' anchor they move opposite sides of the anchor —
   *   dwell pushes the onward departure later, slack pulls the arrivals
   *   earlier — which is the one place the split is visible in the arithmetic.
   *
   *   WHAT ACTUALLY DIFFERS IS ROBUSTNESS, and a static plan cannot show it. A
   *   group arriving X late where X <= slack costs nobody anything and the
   *   error does not reach the next meet; the same X against dwell alone moves
   *   every subsequent event by X, and over two meets in a row it accumulates.
   *   That is #67's own argument and it is about what happens when reality
   *   departs from the plan.
   *
   *   AND WHAT THE RIDER IS TOLD. "Be there at 09:30, we roll at 10:00, thirty
   *   minutes of slack" and "be there at 09:30, thirty-minute stop, we roll at
   *   10:00" are the same three numbers and different instructions. The
   *   roadbook renders them differently, which is reason enough for two columns
   *   even where the arithmetic agrees.
   */
  slackMin: number
}

export type Solved = {
  subgroupId: number
  /** Epoch ms. When this strand leaves its own start. */
  departAt: number
  /** Epoch ms. When this strand is asked to be at the meet — `slackMin` before
   *  the shared departure minus dwell, which is what makes the margin real. */
  arriveAt: number
}

export type Solution = {
  strands: Solved[]
  /** Epoch ms. When the converged group leaves the meeting point. Every strand
   *  shares it, which is the point of a meet. */
  meetDepartAt: number
  /** Epoch ms. When the ride ends, per strand — they can differ if the ride
   *  splits again on the way home. */
  endAt: number
}

/**
 * Solve every strand against one anchor.
 *
 * `anchorAt` means whichever event `anchor` names, read off the PRIMARY
 * subgroup where the anchor is per-group:
 *
 *   'departure'  the primary group leaves at anchorAt
 *   'meet'       everybody is at the meeting point at anchorAt — the only
 *                anchor that does not depend on which group is primary, and
 *                `primaryId` is ignored for it
 *   'arrival'    the primary group reaches the end of the ride at anchorAt
 *
 * A missing or unknown `primaryId` falls back to the LONGEST strand rather than
 * to the first. That is not tidiness: #67 is explicit that the default must not
 * be the planner's own group, because it is the one most likely to be nearest
 * the meet — so defaulting to it reproduces the unfair-6am case every time and
 * the planner does not notice, being the one who rode three miles. The longest
 * approach is the group with the most to lose from a bad answer.
 */
export function solveStrands(
  strands: Strand[],
  cost: MeetCost,
  anchor: TimeAnchor,
  anchorAt: number,
  primaryId: number | null,
): Solution | null {
  if (strands.length === 0) return null

  const primary = strands.find((s) => s.subgroupId === primaryId) ?? longestStrand(strands)
  const dwellMs = cost.dwellMin * MIN
  const slackMs = cost.slackMin * MIN

  // Everything is solved through ONE number — when the group leaves the meet —
  // because that is the only instant every strand genuinely shares. Each anchor
  // is just a different way of being told it.
  const meetDepartAt =
    anchor === 'meet'
      ? anchorAt + dwellMs
      : anchor === 'departure'
        ? // The primary group leaves when they said; they reach the meet after
          // their own riding time, and they have been asked to be slack minutes
          // early, so the shared departure is that plus the slack plus dwell.
          anchorAt + primary.toMeetS * 1000 + slackMs + dwellMs
        : // 'arrival': work backwards from the primary group's end of ride.
          anchorAt - primary.fromMeetS * 1000

  const arriveAt = meetDepartAt - dwellMs
  return {
    strands: strands.map((s) => ({
      subgroupId: s.subgroupId,
      // SLACK IS SPENT HERE AND NOWHERE ELSE. Each strand is asked to be at the
      // meet slackMin before the group actually needs to move, so a group up to
      // that late costs nobody anything. Fold slack into dwell instead and every
      // minute of lateness moves the whole rest of the day.
      arriveAt: arriveAt - slackMs,
      departAt: arriveAt - slackMs - s.toMeetS * 1000,
    })),
    meetDepartAt,
    endAt: meetDepartAt + Math.max(...strands.map((s) => s.fromMeetS)) * 1000,
  }
}

/** The strand with the most riding to do before the meet. The fallback primary,
 *  and separately what the builder shows as its suggestion. */
export function longestStrand(strands: Strand[]): Strand {
  return strands.reduce((a, b) => (b.toMeetS > a.toMeetS ? b : a))
}

/**
 * How much earlier than the group's own departure each strand has to leave.
 *
 * The number a planner actually wants beside the primary-group choice, because
 * it is the unfairness made visible: Oakland leaves at 08:40, Sacramento at
 * 06:10, and switching primary swaps which of those two is the round number.
 * #67 asks for exactly this to be shown beside the choice.
 */
export function departureSpreadMs(solution: Solution): number {
  const times = solution.strands.map((s) => s.departAt)
  return Math.max(...times) - Math.min(...times)
}

/**
 * Whether this solve asks anybody to leave before a civilized hour, and who.
 *
 * A warning rather than a refusal — a rally really does sometimes start at 5am,
 * and the app has no business saying otherwise. But an anchor chosen without
 * looking routinely produces one, and the planner is the least likely person to
 * notice, being the one who rode three miles.
 *
 * The hour is read in UTC because a day's clock is a WALL CLOCK at the departure
 * point carried as UTC — see days.start_at. Converting to anyone's local time
 * here would be the exact bug that comment exists to prevent.
 */
export function unsociableDepartures(solution: Solution, beforeHour = 6): number[] {
  return solution.strands.filter((s) => new Date(s.departAt).getUTCHours() < beforeHour).map((s) => s.subgroupId)
}
