// The guided tour's assets, for every page it visits.
//
// The tour follows the rider across pages — the roster, the paddock on
// /profile, /riders, the viewer — so each of those has to carry Shepherd and
// tour.js, and one place spelling the two <link>s is what keeps the SRI hash
// and the version from drifting between five files. The builder carries them
// always, because it is where a tour starts; every other page carries them
// ONLY WHILE A TOUR IS IN PROGRESS (the session's `tourRideId`), so a rider
// who is not on the tour never fetches a module from a CDN for a page that
// would not use it.
//
// See the long note on the script block in routes/builder.ts for why this is
// a modulepreload plus a dynamic import from a classic script, and why the
// builder must never wait on it.
import type { UserRow } from '../db/schema'
import { asset } from './assets'

export const TOUR_HEAD = `<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/shepherd.js@15.3.0/dist/css/shepherd.css" integrity="sha384-C5yWgOSmSD4vj/xah+gT81JJz/Q4ZA+7m86bpX6cHQvmoEb0XdlZk1Kt02f/rH0l" crossorigin="anonymous">
  <link rel="modulepreload" id="shepherd-module" href="https://cdn.jsdelivr.net/npm/shepherd.js@15.3.0/dist/js/shepherd.mjs" integrity="sha384-3c9ULgNKnju6snpqV4Hwd0Kku2L97ceRjbGdQZ8xu/d9IMhkkj3JqcTyKmImgPtg" crossorigin="anonymous">`

export const tourScript = (): string => `<script src="${asset('/js/tour.js')}" defer></script>`

/** Whether this rider is mid-tour, read off the session user. Through
 *  `unknown` for the reason layout.tsx reads the display preferences that
 *  way: the session type carries more than UserRow says. */
export const onTour = (user: UserRow | null): boolean =>
  typeof (user as unknown as { tourRideId?: unknown } | null)?.tourRideId === 'number'

/** The head and script a non-builder page adds while a tour is in progress,
 *  or nothing. */
export function tourAssets(user: UserRow | null): { head: string; scripts: string } {
  return onTour(user) ? { head: TOUR_HEAD, scripts: tourScript() } : { head: '', scripts: '' }
}
