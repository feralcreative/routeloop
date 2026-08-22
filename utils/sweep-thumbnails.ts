// Runs one thumbnail sweep by hand and prints what it did.
//
// The app runs this on a five-minute timer, so this script is not how
// thumbnails normally get built. It is here for the two cases where waiting is
// wrong: draining the backfill after the Maps Static API is first enabled, when
// every ride in the database is a candidate at once and MAX_PER_SWEEP means
// several passes; and checking a key or a quota change without restarting the
// server.
//
//   npx tsx utils/sweep-thumbnails.ts
//   npx tsx utils/sweep-thumbnails.ts --until-done
//
// Note utils/ is not in tsconfig.json, so `npm run typecheck` does not cover
// this file — see AGENTS.md for the one-off tsc invocation that does.
import { sweepThumbnails } from '../src/maps/thumbnail-sweep'

const untilDone = process.argv.includes('--until-done')

let pass = 0
for (;;) {
  const { checked, built, skipped } = await sweepThumbnails()
  pass++
  console.log(`pass ${pass}: checked ${checked}, built ${built}, skipped ${skipped}`)
  // `checked` is what bounds the loop, not `built`: a pass that skipped
  // everything still stamped those rows, so the next pass sees fewer. Looping on
  // `built` would spin forever on a corpus where nothing needs rebuilding.
  if (!untilDone || checked === 0) break
}

process.exit(0)
