// The splash backdrop's clips: the contents of public/video/splash/, listed
// once at startup.
//
// **A FOLDER, NOT A FILE, AND THE PAGE SHUFFLES IT.** Ziad's call, 2026-09-20.
// The sign-in page played one stitched 2.9 MB file, and refreshing it meant
// re-editing and re-encoding one file. Now utils/splash-clips.sh writes
// matched five-second clips into this folder and public/js/site.js shuffles
// and crossfades them, so adding variety is dropping a download in a folder
// and running the script.
//
// **READ ONCE, AT STARTUP.** Runtime rather than build time, so a new clip
// needs a restart and nothing else; once rather than per request, so the
// directory is not stat'd on every visit to the front door. An empty folder
// — a clone with no clips — is an empty list, which site.js reads as "poster
// only" rather than an error.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(process.cwd(), 'public', 'video', 'splash')

function list(): string[] {
  try {
    return readdirSync(DIR)
      .filter((f) => f.endsWith('.mp4'))
      .sort()
      .map((f) => `/video/splash/${f}`)
  } catch {
    return []
  }
}

/** The clips' URLs, sorted; the page shuffles them itself. */
export const SPLASH_CLIPS: readonly string[] = list()
