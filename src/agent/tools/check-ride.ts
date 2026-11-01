// check_ride: the readiness audit as one tool (#454). The rules are in
// src/agent/checks.ts; this file only words the result.
import { z } from 'zod'
import { CHECKS, runChecks, tripQuestions } from '../checks'
import { cite } from '../provenance'
import type { Tool } from '../tools'

const tool = <S extends z.ZodObject>(t: Tool<S>) => t

export const checkRide = tool({
  name: 'check_ride',
  cap: { mutates: false, needs: 'view' },
  description:
    'Audit the ride before anyone rides it. Returns two verdicts, never one “ready”: ROUTE CHECKS, worst first (fuel where the tank runs dry, legs never drawn, empty routes, missing departures, arrivals after the stop-by time or midnight, long days, alternates), each with the route, the place, the number, and the fix; and TRIP CHECKS only the riders can confirm. Weather and road closures are separate tools (get_conditions, get_road_reports). Run it before saying a ride is ready, and again after fixing.',
  schema: z.object({}).strict(),
  run: async (ctx) => {
    const findings = runChecks(ctx)
    const out = [`ROUTE CHECKS ${cite({ kind: 'computed', source: 'Routeloop' })}`]
    if (!findings.length) out.push('Nothing found in the ride’s own data.')
    for (const f of findings) {
      const c = CHECKS.find((x) => x.id === f.check)!
      out.push(`- [${c.severity}] ${c.title}. ${f.detail}`)
      if (c.mapSymbol) out.push(`  On the map: ${c.mapSymbol}.`)
      out.push(`  Fix: ${f.fix}`)
    }
    out.push(
      'Not checked here: the weather (get_conditions, per dated route), rider road reports and seasonal closures (get_road_reports), and sunset (get_conditions).',
    )
    out.push('', 'TRIP CHECKS (ask the riders; never assume):', ...tripQuestions(ctx).map((q) => `- ${q}`))
    return out.join('\n')
  },
})
