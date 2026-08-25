// `/rides`, which is now a redirect and nothing else.
//
// The history is worth keeping because this URL has moved twice and the second
// move undid the first. It was `dashboard.tsx` at `/dashboard` until 2026-08-15,
// when it became `/rides` on the grounds that the old URL described the page as
// a dashboard while the actual dashboard was `/`. That was true, and it fixed
// the wrong half of the problem: the app still had two doors onto a rider's own
// rides — `/` carrying a six-ride "Picking up where you left off" strip, and
// this page carrying the full list.
//
// Folded into `/` on 2026-08-24, Ziad's call, answering the third of #103's four
// open questions. `OwnRideRow` moved to home.tsx with its contract intact; see
// the note there about why it is deliberately not `views/cards.tsx`.
//
// A 302 RATHER THAN A 301, and the difference is deliberate. `/dashboard` →
// `/rides` was a 301 because that move was permanent and a cached redirect was
// the desired outcome. This one is a layout decision about whether the stats and
// the list belong on one page, and that decision has already been revisited once
// in nine days. A 301 is close to irreversible in a browser that has seen it —
// it would outlive any change of mind here, in a cache nobody can reach.
import { Hono } from 'hono'
import type { AuthEnv } from '../auth/middleware'

export const ridesRoutes = new Hono<AuthEnv>()

// No `requireActive`. The gate belongs on the destination, which has it, and a
// signed-out visitor following an old bookmark should land wherever `/` sends
// them rather than at a login wall that then drops them somewhere else.
ridesRoutes.get('/rides', (c) => c.redirect('/', 302))
