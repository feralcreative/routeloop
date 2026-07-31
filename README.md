# tankbag

tankbag (tankbag.app) is a web app for **planning, organizing, and sharing** motorcycle rides and car road trips. Riders build a route on an interactive map—dropping stops, classifying them (gas, food, camp, lodging, scenic…), with the road route snapped between them—then manage it, share it by link, and export it. Existing route files (KML, GPX) can be imported to migrate in.

It is deliberately a **planning and sharing tool, not a turn-by-turn navigation app**. The problem it solves: Google My Maps caps at ~10 waypoints and one route per layer and can't be used to navigate—tankbag has no such limits and gives a holistic view of an entire multi-day trip. For deep technical onboarding see [\_AI_AGENT_PRIMER.md](_AI_AGENT_PRIMER.md); the vision is in [docs/ideas.md](docs/ideas.md); current state and next steps are in [docs/STATUS.md](docs/STATUS.md).

## Status

Active build on a **TypeScript + Hono + PostgreSQL** stack, hosted on a Synology NAS behind a Cloudflare Tunnel. The product pivoted from "upload KML files" to "plan rides in-app"; upload is now an import path.

**Live at [tankbag.app](https://tankbag.app).** The app briefly shipped as `routeloop.app` in July 2026; that name was reverted on 2026-07-29 and `routeloop.app` now permanently redirects here. Public and unlisted ride links are reachable without signing in.

Two replacements are in flight on the `refactor/google-maps-and-auth` branch. Both are described precisely in [docs/STATUS.md](docs/STATUS.md), which is the document that stays current:

| | Being replaced | Replacement | State |
| --- | --- | --- | --- |
| Auth | Cloudflare Access | Google OAuth + emailed magic link, owned by the app | Committed; needs an OAuth client and SMTP credentials before it can run |
| Maps | Mapbox GL + Directions + Geocoding | Google Maps JS + Places (New) + Routes | Engine ported and verified 2026-07-30; only `profile.js` geocoding and dead config remain |

Auth is changing because Cloudflare Access is billed **per seat**, which cannot survive opening signups. Maps changed because place search on Mapbox Geocoding was not good enough for finding businesses, and each provider's terms tie their search results to their own basemap—so it was the whole engine or nothing. The reasoning for both is recorded in [docs/decisions-auth-and-search.md](docs/decisions-auth-and-search.md).

**The deployed build still uses Cloudflare Access**, restricted to a single owner address, and the production database starts empty. The Access policy must not be removed until the new auth code is deployed, or the running app would be left open.

Delivered in phases:

- [x] **Data model**—rides → routes → stops/POIs → routed legs; the 17-role taxonomy
- [x] **Import**—KML/GPX upload becomes a structured, editable ride
- [x] **Ride builder**—plan a road-snapped route, classify stops, save
- [x] **Native viewer**—shared rides render from the database
- [x] **User profiles**—`users.status` authorization, profile page, home-address seeding
- [x] **Auth replacement**—Google OAuth + magic link _(code complete; awaiting credentials)_
- [ ] **Maps migration**—move rendering, search and routing to Google _(in progress)_
- [ ] **Shaping + export**—drag routes into shape; export KML/GPX
- [ ] **Trip features**—multi-day rides and the timeline slider
- [ ] **Later**—bikes, saved places, admin panel, more import formats, PostGIS

## What it does

- **Plan**—build a route on a map: click or search to add stops, and the road route is snapped between them. Classify each stop with the 17-role taxonomy (gas, food, camp, meet, scenic…).
- **Organize**—a ride packages one or more routes (days/sessions); stops, points of interest, and ephemeral shaping waypoints are distinct.
- **Share**—public, unlisted, or private visibility, shareable by link.
- **Import**—bring in existing `.kml` / `.gpx` to migrate from other tools _(KMZ, CSV later)_.
- **Export**—download a ride as KML/GPX for other apps and round-tripping _(not yet built)_.
- **Accounts**—sign in with Google or an emailed magic link. Every new account starts `pending` and must be approved before it can use the app; each account has a storage quota for imported files.

## Tech stack

- **Backend**—TypeScript on Hono (Node in Docker; portable to Cloudflare Workers), PostgreSQL via Drizzle ORM, Zod validation.
- **Maps**—Google Maps JavaScript API for rendering, Places (New) `AutocompleteSuggestion` for search, and the Routes API for per-leg road routing. The front end has no bundler; the inline bootstrap loader defines `google.maps.importLibrary` and libraries load on demand. Routing goes through a server-side proxy at `POST /api/route`, because the Routes key is IP-restricted and cannot be used from a browser. `public/js/map-common.js` is the only file that touches `google.maps`—the viewer and builder go through the handles it returns.
- **Auth**—Google OAuth (via `arctic`) and an emailed magic link both resolve into the same hand-rolled server sessions, whose primary key is the SHA-256 hash of the browser token rather than the token itself. Authorization is separate: `users.status` (`pending` | `active` | `blocked`) decides who may actually use the app. Cloudflare Turnstile guards uploads and saves, feature-flagged off until keys are set.
- **Hosting**—Synology NAS (Docker) behind a Cloudflare Tunnel; HTTPS terminates at the Cloudflare edge and no inbound ports are open on the NAS.

> A legacy Google Maps viewer (`public/js/main.js`) still renders **imported** rides on its own shell. It survived the Mapbox era as the reference implementation for the port back to Google, and retires in Phase 4 once the current engine learns to draw an imported ride's single-leg track—which `ride.json` already serves identically for both sources.

## Local development

### Requirements

- Node.js 20+
- Docker (to run PostgreSQL locally)
- Google Cloud credentials—a referrer-restricted browser key, an IP-restricted server key and a vector Map ID (see [docs/google-cloud-setup.md](docs/google-cloud-setup.md)). Without the Map ID, Advanced Markers render nothing at all, with no error

### Setup

1. Install dependencies and start Postgres:

   ```bash
   npm install
   docker compose up -d --wait db
   ```

2. Create a git-ignored `.env` from `.env.example` and fill it in. The essential dev keys:

   ```text
   PORT=6686
   MAPBOX_TOKEN=pk.<public token—only profile.js still uses this>
   GMAPS_KEY=<Google browser key, referrer-restricted>
   STORAGE_PATH=./moto-storage
   DATABASE_URL=postgresql://tankbag:tankbag_dev_pw@127.0.0.1:5432/tankbag
   APP_ORIGIN=http://127.0.0.1:6686
   ```

`MAPBOX_TOKEN` is now needed only by `public/js/profile.js`, which still geocodes the home address against Mapbox; it goes away once that moves to a server proxy. For the Google keys—browser, server, OAuth client, Map ID—see [docs/google-cloud-setup.md](docs/google-cloud-setup.md).

3. Apply the schema and seed a sample ride:

   ```bash
   npx drizzle-kit push
   npx tsx src/db/seed.ts
   ```

4. Compile styles if you changed the SCSS:

   ```bash
   npm run sass
   ```

### Run

```bash
npm run dev
```

Then open <http://localhost:6686>. The seed ride is at `/m/sample-route-one`; the builder is at `/builder`.

Either `localhost` or `127.0.0.1` works. The browser key allows both on port 6686 and `isAllowedOrigin` accepts both, so the CSRF gate passes either way. (An older note preferring `localhost` was a Mapbox token restriction and no longer applies.)

Port 6686 belongs to this project. If it is already bound, kill the process and reuse the port rather than starting on a different one.

Until the OAuth client and SMTP credentials exist there is **no way to sign in locally**: the old Cloudflare Access bypass is deleted, and both new sign-in methods hide themselves when unconfigured rather than offering a broken button. To exercise an authenticated route before then, mint a session directly:

```bash
npx tsx -e "import('./src/auth/session').then(async m => console.log(await m.createSession(1)))"
# send it as: Cookie: tankbag_session=<token>
```

## Project structure

```text
src/                  TypeScript app (Hono)
  index.ts            Home, viewer (native / legacy imported shells), ride.json,
                      legacy metadata + gated file streams
  config.ts           Env-derived config, allowed origins, CSRF helpers
  db/                 Drizzle schema (source of truth), connection, dev seed
  auth/               google.ts (OAuth), magic.ts (magic link), mailer.ts,
                      identity.ts (provider-agnostic user resolution),
                      session.ts, middleware.ts (auth + status gates)
  maps/               roles.ts, kml.ts, storage.ts, slug.ts, turnstile.ts
  routes/             maps.ts (import), rides.ts (builder), routing.ts
                      (Routes API proxy), dashboard.ts, profile.ts, auth.ts
  views/layout.ts     Shared chrome shell
public/
  js/main.js          Legacy Google viewer, imported rides—retires in Phase 4
  js/map-common.js    Shared Google engine—ONLY file touching google.maps
  js/viewer.js        Native ride viewer
  js/builder.js       The ride builder
  js/profile.js       Profile page (address geocoding)
  style/main.min.css  Compiled CSS (build artifact, git-ignored)
  img/icons/          17 role SVGs (currentColor) + UI icons
style/main.scss       SCSS source
docker-compose.yml    PostgreSQL for dev (app service at deploy time)
drizzle.config.ts     Drizzle Kit config
docs/                 STATUS.md (current state), ideas.md (vision),
                      decisions-auth-and-search.md, google-cloud-setup.md
_PLANS/               Plans + session handoff
app/, utils/schema.sql  Legacy PHP/MySQL (superseded; reference only)
```

Imported files live in a private `STORAGE_PATH` **outside** the web root, served only through an ownership and visibility check. Native rides are pure database rows.

## The data model

- **Ride**—the shareable package (slug, visibility, title): holds many routes.
- **Route**—one day/session: an ordered list of stops joined by road-snapped legs, with an optional start/end date-time.
- **Points** come in two kinds: **Stops** (ordered routing anchors, can carry a duration) and **POIs** (unordered annotations that don't affect routing). Ephemeral **shaping waypoints** are stored on the leg, not as points.
- **Legs** carry the snapped geometry and the distance/duration between consecutive stops. Imported rides are stored as one route with a single full-track leg, so imported and native rides render through one code path.

Geometry is stored as `[lng, lat]` pairs—GeoJSON order. The Routes API returns that order too when asked for `GEO_JSON_LINESTRING`, so the migration needed no data backfill. Google's own JavaScript objects use `{lat, lng}`, and getting the two confused still renders a map, just in the wrong place, so exactly two functions do the conversion: `toGoogleWaypoint` on the server and `toLatLng`/`fromLatLng` in `map-common.js` on the client.

## Waypoint roles (classification, import & export)

Stops and POIs are classified with a 17-role taxonomy defined canonically in `src/maps/roles.ts`. In the builder you pick roles from icons; on **import** the `ROLE - Name` name-prefix convention is parsed into roles, and on **export** it is written back so files round-trip through other tools (Google Earth, etc.).

Prefix a name with a type, and combine up to four with `/`:

```text
GAS - Chevron Station
GAS/BREAK/FOOD - Roadside Stop
```

Supported types and the alternate words that map to them:

| Type    | Icon file        | Also matches                        |
| ------- | ---------------- | ----------------------------------- |
| START   | icon-start.svg   | BEGIN                               |
| FINISH  | icon-finish.svg  | END                                 |
| HOME    | icon-home.svg    | HOUSE                               |
| MEET    | icon-meet.svg    | MEETUP, JOIN, MEETING, CONVERGE     |
| SPLIT   | icon-split.svg   | DEPART, DIVERGE, LEAVE              |
| GAS     | icon-gas.svg     | FUEL                                |
| CHARGE  | icon-charge.svg  | CHARGER                             |
| BREAK   | icon-break.svg   | REST                                |
| CAMP    | icon-camp.svg    | CAMPGROUND, CAMPING, CAMPSITE       |
| HOTEL   | icon-hotel.svg   | LODGING, MOTEL, AIRBNB, SLEEP, STAY |
| FOOD    | icon-food.svg    | LUNCH, DINNER, BREAKFAST            |
| COFFEE  | icon-coffee.svg  | CAFE                                |
| DRINKS  | icon-drinks.svg  | BAR, COCKTAILS, BEER, BEERS         |
| GROCERY | icon-grocery.svg | GROCERIES                           |
| VIEW    | icon-view.svg    | SCENIC, LOOKOUT, VIEWPOINT          |
| POI     | icon-poi.svg     | STOP                                |
| WTF     | icon-wtf.svg     | WEIRD, RANDOM                       |

Icons live in `public/img/icons/`, designed in [this Figma document](https://www.figma.com/design/pFQck3CUIa5twKqMu1IxD5/moto-router). Their fill is `currentColor` so each icon tints to match its route color.

## Deployment

Target host is a Synology NAS. The app runs as a Docker container behind a Cloudflare Tunnel, with PostgreSQL as a sibling container. HTTPS terminates at Cloudflare's edge and no inbound ports are open on the NAS.

Each container publishes two host ports and answers on both. Production serves `tankbag.app` from `localhost:6686`, with `routeloop.app` on `localhost:16703` redirecting to it; staging serves `stage.tankbag.app` from `localhost:16687`, with `stage.routeloop.app` on `localhost:6687` redirecting to it. Because all four tunnel routes already point at these containers, changing the canonical name needed no tunnel or DNS change.

```bash
./utils/deploy/stage.sh --dry-run   # preview
./utils/deploy/stage.sh             # stage.tankbag.app
./utils/deploy/prod.sh              # tankbag.app
```

Production refuses a dirty tree or a non-`main` branch. Staging has neither gate, so it is the one to use from a feature branch.

> **Note on the `maps` → `rides` rename.** The post-deploy `drizzle-kit push` runs non-interactively and cannot resolve a table rename. Production sidestepped this by being redeployed onto a fresh, empty database, so it is settled there. Any older database that still has a `maps` table needs `DROP TABLE IF EXISTS maps CASCADE;` before a deploy will succeed.

## Provenance

tankbag reuses the client-side map engine from the original Moto-Rooter static viewer, recovered from git history. The backend was rebuilt PHP/MySQL → TypeScript + Hono + PostgreSQL, then the product pivoted from file upload to the in-app ride builder. The rendering behavior, mileage math, and waypoint taxonomy were ported forward; the upload path survives as import.
