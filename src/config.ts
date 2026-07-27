// Single source for env-derived constants. Before this existed, MAPBOX_TOKEN was
// read independently in src/index.ts and src/routes/rides.ts, and the Mapbox GL
// version was a const in index.ts but a hardcoded string twice in rides.ts —
// so the viewer and the builder could silently load different library versions.
import 'dotenv/config'

export const PORT = Number(process.env.PORT ?? 6686)

// The one account that is never left waiting for approval. Both databases have
// been rebuilt from empty before, and without this the owner would come back
// 'pending' after the next rebuild with nobody able to approve them.
export const OWNER_EMAIL = (process.env.OWNER_EMAIL ?? 'ziad@feralcreative.co').trim().toLowerCase()

export const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN ?? ''
export const MAPBOX_GL_VERSION = 'v3.10.0'

// Legacy Google viewer, imported rides only. Retires in Phase 4.
export const GMAPS_KEY = process.env.GMAPS_KEY ?? ''

// Alpha splash links. These are public URLs, not secrets, so they default to
// the real values — that keeps prod correct without adding three more variables
// to the deploy plumbing. Env still overrides, and setting one to an empty
// string omits that link rather than rendering a dead one.
export const ALPHA_GITHUB_URL =
  process.env.ALPHA_GITHUB_URL ?? 'https://github.com/feralcreative/routeloop/issues'
export const ALPHA_SIGNAL_URL = process.env.ALPHA_SIGNAL_URL ?? 'https://feral.ly/signal'
export const ALPHA_DISCORD_URL = process.env.ALPHA_DISCORD_URL ?? 'https://discord.gg/5wqFRxqzxN'
