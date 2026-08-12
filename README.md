# RouteLoop

RouteLoop (routeloop.app) is a web app for **planning, organizing, and sharing** motorcycle rides and car road trips. Riders build a route on an interactive map—dropping stops, classifying them (gas, food, camp, lodging, scenic…), with the road route snapped between them—then manage it, share it by link, and export it. Existing route files (KML, GPX) can be imported to migrate in.

It is deliberately a **planning and sharing tool, not a turn-by-turn navigation app**. The problem it solves: Google My Maps caps at ~10 waypoints and one route per layer and can't be used to navigate—RouteLoop has no such limits and gives a holistic view of an entire multi-day ride. For deep technical onboarding see [AGENTS.md](AGENTS.md); the vision is in [docs/ideas.md](docs/ideas.md); the dev roadmap is in [docs/ROADMAP.md](docs/ROADMAP.md); current state and next steps are in [docs/STATUS.md](docs/STATUS.md).

## Status

Active build on a **TypeScript + Hono + PostgreSQL** stack, hosted on a Synology NAS behind a Cloudflare Tunnel. The product pivoted from "upload KML files" to "plan rides in-app"; upload is now an import path.

**Live at [routeloop.app](https://routeloop.app).** The app shipped as `routeloop.app`, moved to `tankbag.app` on 2026-07-29, and moved back on 2026-08-11; `tankbag.app` now permanently redirects here. As developer and designer on this project, I reserve the right to change the name and logo several more times before I actually launch, and the evidence so far is that I will. Public and unlisted ride links are reachable without signing in.

Two replacements drove the `refactor/google-maps-and-auth` branch. **Both are finished and deployed**, and the table is kept as history rather than as work. Current state lives in [docs/STATUS.md](docs/STATUS.md), which is the document that stays current:

|      | Was replaced                       | By                                                  | State                                                                                                              |
| ---- | ---------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Auth | Cloudflare Access                  | Google OAuth + emailed magic link, owned by the app | **Deployed 2026-07-30** and signing in ever since; the Access policy at the Cloudflare edge still has to be pulled |
| Maps | Mapbox GL + Directions + Geocoding | Google Maps JS + Places (New) + Routes              | **Done.** Rendering, search, routing and geocoding all on Google; no `MAPBOX_*` value is read anywhere             |

Auth changed because Cloudflare Access is billed **per seat**, which cannot survive opening signups. Maps changed because place search on Mapbox Geocoding was not good enough for finding businesses, and each provider's terms tie their search results to their own basemap—so it was the whole engine or nothing. The reasoning for both is recorded in [docs/decisions.md](docs/decisions.md).

**The only loose end is at the edge, not in the repo:** the Cloudflare Access policy is still defined and is now pure redundancy, since the deployed app has not read the header it injects since 2026-07-30. That ordering mattered—pulling the policy before the code shipped would have left the running app open—and it is satisfied, so the policy can go whenever.

Delivered in phases:

- [x] **Data model**—rides → days → stops/POIs → routed legs; the 17-role taxonomy
- [x] **Import**—KML/GPX upload becomes a structured, editable ride
- [x] **Ride builder**—plan a road-snapped route, classify stops, save
- [x] **Native viewer**—shared rides render from the database
- [x] **User profiles**—`users.status` authorization, profile page, home-address seeding
- [x] **Auth replacement**—Google OAuth + magic link _(deployed to production 2026-07-30)_
- [x] **Maps migration**—rendering, search and routing on Google _(deployed 2026-07-30)_
- [x] **Multi-day builder**—every day of a ride drawn on one map, with a day-focus slider
- [x] **Admin panel**—owner approves, blocks and reinstates rider accounts
- [x] **Ride timeline**—per-day date-times and the timeline slider
- [x] **Import and export**—six formats in, five out; several files become the days of one ride
- [x] **Roadbook**—a printable stop-by-stop sheet
- [x] **Expand + the Google Maps hand-off**—`/m/:slug/navigate`, nine waypoints per link
- [x] **Shaping**—drag the route line onto the road you meant
- [x] **Undo and crash-recovery drafts** in the builder
- [ ] **The group layer**—ride membership, friendships, and the visibility levels that need both
- [ ] **Later**—bikes, saved places, on-the-road mobile interface, PostGIS

## What it does

- **Plan**—build a route on a map: click or search to add stops, and the road route is snapped between them. Classify each stop with the 17-role taxonomy (gas, food, camp, meet, scenic…).
- **Organize**—a ride packages one or more days, all drawn on **one map at the same time** so you see the whole ride; a slider focuses a single day by dimming the rest. Stops, points of interest, and ephemeral shaping waypoints are distinct.
- **Share**—public, unlisted, or private visibility, shareable by link.
- **Import**—drop in existing `.kml` / `.kmz` / `.gpx` / `.geojson` / `.csv`, or a `.zip` of them, to migrate from other tools. Several files at once become the days of one ride, and files following the naming convention below arrive already named, ordered and dated.
- **Export**—download any ride as KML, GPX, GeoJSON or CSV, whatever it was built or imported as, or as RouteLoop JSON for a lossless backup that re-imports as the same ride. A multi-day ride can also come down as a zip of one conforming file per day.
- **Roadbook**—a printable stop-by-stop sheet for the tank bag: leg and cumulative miles, miles since fuel, and an estimated clock.
- **Shape**—drag the route line onto the road you actually meant. The dropped point becomes an ephemeral shaping waypoint on that leg, and only that leg re-routes.
- **Hand off**—`/m/:slug/navigate` turns a day into an ordered series of Google Maps links, with an **Expand** density control that weaves in shaping points so Maps has too little room to pick its own roads. It also states the longest stretch Maps still chooses for itself rather than hiding it.
- **Accounts**—sign in with Google or an emailed magic link. Every new account starts `pending` and must be approved from the owner's admin panel before it can use the app; each account has a storage quota for imported files.
- **Email**—transactional mail from `routeloop.app` via Resend over SMTP, with replies received free through Cloudflare Email Routing. Four templates: the sign-in link, a waitlist confirmation, an approval notice, and a new-signup alert to the owner. See [docs/email.md](docs/email.md).

## Tech stack

- **Backend**—TypeScript on Hono (Node in Docker; portable to Cloudflare Workers), PostgreSQL via Drizzle ORM, Zod validation.
- **Maps**—Google Maps JavaScript API for rendering, Places (New) `AutocompleteSuggestion` for search, and the Routes API for per-leg road routing. The front end has no bundler; the inline bootstrap loader defines `google.maps.importLibrary` and libraries load on demand. Routing goes through a server-side proxy at `POST /api/route`, because the Routes key is IP-restricted and cannot be used from a browser. `public/js/map-common.js` is the only file that touches `google.maps`—the viewer and builder go through the handles it returns.
- **Auth**—Google OAuth (via `arctic`) and an emailed magic link both resolve into the same hand-rolled server sessions, whose primary key is the SHA-256 hash of the browser token rather than the token itself. Authorization is separate: `users.status` (`pending` | `active` | `blocked`) decides who may actually use the app. Cloudflare Turnstile guards uploads and saves, feature-flagged off until keys are set.
- **Hosting**—Synology NAS (Docker) behind a Cloudflare Tunnel; HTTPS terminates at the Cloudflare edge and no inbound ports are open on the NAS.

> There used to be a second, legacy viewer (`public/js/main.js`) rendering **imported** rides on its own shell. It survived the Mapbox era as the reference implementation for the port back to Google and was deleted on 2026-08-01, once it turned out the current engine already drew an imported ride correctly—`ride.json` had been serving both sources identically since per-leg spans were added. One viewer, one shell.

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
   GMAPS_KEY=<Google browser key, referrer-restricted>
   GMAPS_SERVER_KEY=<Google server key, IP-restricted — Routes + Geocoding>
   GMAPS_MAP_ID=<vector Map ID — without it, Advanced Markers render nothing>
   STORAGE_PATH=./moto-storage
   DATABASE_URL=postgresql://routeloop:routeloop_dev_pw@127.0.0.1:5432/routeloop
   APP_ORIGIN=http://127.0.0.1:6686
   ```

   For all four Google credentials—browser key, server key, OAuth client and Map ID—see [docs/google-cloud-setup.md](docs/google-cloud-setup.md). There is no `MAPBOX_TOKEN` any more; the last Mapbox call moved server-side to `POST /api/geocode` on 2026-08-01.

3. Apply the schema and seed a sample ride:

   ```bash
   npm run db:migrate
   npx tsx src/db/seed.ts
   ```

   `npm run dev` applies pending migrations too, via `predev`, so switching between machines needs no separate step. Schema changes are generated files under `drizzle/`—see [docs/database.md](docs/database.md), which also covers the one-time baseline an older database needs.

   The seed reads `moto-storage/1/1.kml` for its imported sample ride. Storage is gitignored, so on a fresh checkout that file is absent and the seed stops there; `utils/seed-dev.sh --rides-only` seeds generated native rides instead.

4. Compile styles if you changed the SCSS:

   ```bash
   npm run sass
   ```

### Run

```bash
npm run dev
```

This runs the server, the SCSS watcher and live reload together—edit a stylesheet and the page updates without reloading. See [CONTRIBUTING.md](CONTRIBUTING.md) for the details and for `dev:server`, which starts the server alone.

Then open <http://localhost:6686>. The seed ride is at `/m/sample-route-one`; the builder is at `/builder`.

One seeded ride is not enough to judge how the dashboard or the viewer read. To fill dev with varied, genuinely road-routed rides:

```bash
npx tsx utils/seed-demo-rides.ts                 # ~12 rides
npx tsx utils/seed-demo-rides.ts --reset         # replace the previous set
npx tsx utils/seed-demo-rides.ts --straight      # skip the API, straight legs
npx tsx utils/seed-demo-rides.ts --owner=you@example.com
```

Legs come from the real Routes API so tracks follow actual roads, cached in a gitignored file so re-runs cost nothing. The RNG is seeded, so the same rides come back every time and a UI change is never confused with new data. It refuses to run unless `DATABASE_URL` is local.

Either `localhost` or `127.0.0.1` works. The browser key allows both on port 6686 and `isAllowedOrigin` accepts both, so the CSRF gate passes either way. (An older note preferring `localhost` was a Mapbox token restriction and no longer applies.)

Port 6686 belongs to this project. If it is already bound, kill the process and reuse the port rather than starting on a different one.

Sign-in works locally once the Google OAuth client and SMTP credentials are in `.env`; both methods hide themselves when unconfigured rather than offering a broken button, and the old Cloudflare Access bypass is deleted. Note the SMTP values now gate **all** outbound mail, not just the magic link—with them unset, approval and signup notifications are skipped too (logged, not failed). To script an authenticated request without a browser round trip, mint a session directly:

```bash
npx tsx -e "import('./src/auth/session').then(async m => console.log(await m.createSession(1)))"
# send it as: Cookie: routeloop_session=<token>
```

## Project structure

```text
src/                  TypeScript app (Hono)
  index.tsx           Home, viewer (one shell for both sources), ride.json,
                      gated download streams
  config.ts           Env-derived config, allowed origins, CSRF helpers
  content/            Static prose as HTML—faq, privacy, terms
  db/                 Drizzle schema (source of truth), connection, dev seed
  auth/               google.ts (OAuth), magic.ts (magic link), mailer.ts,
                      identity.ts (provider-agnostic user resolution),
                      notify.ts (signup emails), session.ts,
                      middleware.ts (auth + status gates),
                      username.ts, ratelimit.ts
  emails/             Email templates — PURE, no db and no env beyond
                      APP_ORIGIN, so the whole registry is testable.
                      shell.tsx (the one document), theme.ts (palette
                      pinned to _tokens.scss), rules.ts (when to send)
  maps/               roles.ts, kml/kmz/gpx/geojson/csv parsers, export.ts,
                      filename.ts (the naming convention), zip.ts (read +
                      write; kmz.ts is its policy layer), ride-graph.ts,
                      expand.ts, gmaps-links.ts, twist.ts, storage.ts,
                      slug.ts, palette.ts, turnstile.ts
  routes/             maps.ts (import), rides.ts (builder), routing.ts (Routes
                      + Geocoding proxies), admin.tsx (rider approval),
                      dashboard.tsx, profile.tsx, auth.tsx, pages.tsx
                      (explore/riders/profiles/legal), import.tsx,
                      handoff.tsx (navigate), roadbook.tsx
  views/              layout.tsx (chrome shell), splash.tsx (alpha modal),
                      cards.tsx, esc.ts, assets.ts
public/
  js/map-common.js    Shared Google engine—ONLY file touching google.maps
  js/viewer.js        Ride viewer
  js/builder.js       The ride builder—multi-day, one map, day focus slider
  js/builder-history.js  Undo/redo, plus drafts that survive a crash
  js/route-shape.js   Drag-to-shape index math—pure and tested
  js/ride-time.js     Trip time model, shared by builder and viewer
  js/twist.js         Client twistiness, kept equal to the server's
  js/filename.js      The naming convention, kept equal to the server's
  js/import.js        The import drop box — enhancement over a plain form
  js/profile.js       Profile page (address geocoding via /api/geocode)
  style/main.min.css  Compiled CSS (build artifact, git-ignored)
  img/icons/          Role SVGs (currentColor) + UI icons—22 files
style/main.scss       SCSS source
test/                 Vitest suite — pure logic only, no database
  fixtures/           Sample KML/GPX/GeoJSON/CSV of one ride, per format
  helpers/            Test-only helpers. zip.ts builds deliberately MALFORMED
                      archives for the reader's tests and is not src/maps/zip.ts
utils/
  seed-demo-rides.ts  Generates varied, road-routed demo rides in dev
  seed-dev.sh         Rebuilds the dev dataset, carrying accounts across it
  seed-github-issues.sh  Seeds GitHub issues from docs/ROADMAP.md
  backfill-twistiness.ts Fills twistiness columns on pre-existing rows
  tighten-em-dashes.mjs  Prose dash fixer — the pre-commit hook and npm scripts
  deploy/             deploy.sh, prod.sh, stage.sh, deploy-utils.sh (ops +
                      env-to-env cloning), hooks/post-deploy.sh
.githooks/pre-commit  Opt-in: git config core.hooksPath .githooks
.github/workflows/    CI — typecheck + tests on PRs and main
.qlty/                Code quality (biome, prettier, markdownlint, actionlint)
docker-compose.yml    PostgreSQL for dev (app service at deploy time)
drizzle.config.ts     Drizzle Kit config
drizzle/              Generated migrations + meta/ snapshots — committed;
                      applied by db:migrate and the post-deploy hook
vitest.config.ts      Test config — deliberately scoped to pure logic
docs/                 STATUS.md (current state), ROADMAP.md (dev roadmap),
                      ideas.md (vision), decisions.md,
                      google-cloud-setup.md
CONTRIBUTING.md       Setup, gotchas, conventions — start here to contribute
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

## The role taxonomy

Every stop and POI carries one or more of 17 roles, defined canonically in `src/maps/roles.ts`. **In the builder you set them by clicking role icons**—roles are first-class enum values in the database, never encoded in a name.

The `ROLE - Name` name-prefix convention is **only an import and export detail, not how you classify in the app**. When an imported KML/GPX file already labels its placemarks that way—the convention the old file-upload workflow and Google Earth use—RouteLoop parses the prefix into roles on import, and writes it back out on export so files reopen correctly in Google Earth and elsewhere.

So an _imported_ name may carry a prefix, combining up to four roles with `/`:

```text
GAS - Chevron Station
GAS/BREAK/FOOD - Roadside Stop
```

The 17 roles, and the alternate words each matches when parsing an imported name:

| Role    | Icon file        | Also matches (on import)            |
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

## The file naming convention

Every file RouteLoop exports names itself so that dropping a folder of them back in reconstructs the ride. Defined canonically in `src/maps/filename.ts`, mirrored for the browser in `public/js/filename.js`, and the two are held together by `test/filename-client.test.ts`.

```text
routeloop_big-sur-run_d02_2026-08-14_lost-coast.gpx
\_____/ \__________/ \_/ \________/ \_________/
 marker     ride     day    date       title
```

| Field  | Shape                                | Optional | Notes                                                    |
| ------ | ------------------------------------ | -------- | -------------------------------------------------------- |
| marker | literal `routeloop`                    | no       | its absence means the name is not read as structured     |
| ride   | slug                                 | no       | the ride                                                 |
| day    | `d` + digits, zero-padded to two     | yes      | so `d10` sorts after `d09`                               |
| date   | `YYYY-MM-DD`, or `…THHMM` with a time | yes      | the day's start; a bare date means no time was set       |
| title  | slug                                 | yes      | the day's own name                                       |

Three rules the format rests on:

- **Underscores separate fields, hyphens live inside one.** A day title with a dash in it cannot split the filename.
- **The `routeloop_` marker is what makes a name structured.** Without it the importer does exactly what it always did—upload order is day order—so your own `day-2.gpx` is never silently reinterpreted.
- **Optional fields are found by shape, not position.** `routeloop_big-sur-run_d02.gpx` and `routeloop_big-sur-run_2026-08-14.gpx` both parse.

**A filename does not carry the ride, and is not trying to.** Roles, dwell, via points, per-day colours and the stop/POI distinction do not fit in one—`routeloop.json` remains the only lossless format. What the convention carries is the handful of fields the other formats drop, and the one that matters most is the date: **neither GPX nor KML can hold a date at all**, so for those formats the filename is the only place a planned schedule survives a round trip.

Two fields are deliberately absent. **Visibility**, because a file named `public` that publishes a ride on import is a footgun with no upside. And **a timezone**, because the app stores what you typed in your own zone and a filename claiming otherwise would be inventing one.

On the way back in, a title recovered from a filename is a *guess*—`avenue-of-giants` comes back "Avenue Of Giants"—so a file's own internal name (`<trk><name>`, a KML `<Folder>`) wins over it. The date has no such competition and is taken as authoritative.

### Per-day archives

A multi-day ride can be downloaded as one conforming file per day, zipped:

```text
GET /api/public/maps/:slug/zip/{kml|gpx|geojson|csv}

routeloop_big-sur-run.gpx.zip
  ├ routeloop_big-sur-run_d01_2026-08-13_coast-start.gpx
  ├ routeloop_big-sur-run_d02_2026-08-14_lost-coast.gpx
  └ routeloop_big-sur-run_d03_2026-08-15_avenue-of-giants.gpx
```

That archive drags straight back into `/import` and comes out as the ride it left as. A whole-ride download is unchanged and still one file: it is all the days, so there is no one day to name, and it carries the ride's start date and no day field.

## Deployment

Target host is a Synology NAS. The app runs as a Docker container behind a Cloudflare Tunnel, with PostgreSQL as a sibling container. HTTPS terminates at Cloudflare's edge and no inbound ports are open on the NAS.

Each container publishes two host ports and answers on both. Production serves `routeloop.app` from `localhost:16703`, with `tankbag.app` on `localhost:6686` redirecting to it; staging serves `stage.routeloop.app` from `localhost:6687`, with `stage.tankbag.app` on `localhost:16687` redirecting to it. Each hostname has always reached the same port through every rename—what changes is which one is canonical—so changing the name needed no tunnel or DNS change.

```bash
./utils/deploy/stage.sh --dry-run   # preview
./utils/deploy/stage.sh             # stage.routeloop.app
./utils/deploy/prod.sh              # routeloop.app
```

Production refuses a dirty tree or a non-`main` branch; `--force` bypasses both but never the confirmation. Staging has neither gate, so it is the one to use from a feature branch. Both build the image from the **working tree**, not from git, so uncommitted changes ship.

### Moving data between environments

```bash
./utils/deploy/deploy-utils.sh db-clone prod dev     # pull production to your laptop
./utils/deploy/deploy-utils.sh db-clone prod stage   # refresh staging
DEPLOY_ENV=stage ./utils/deploy/deploy-utils.sh db-restore <file.sql.gz>
```

`db-clone` handles all three environments, local dev included, and syncs the KML/GPX storage alongside the database—a cloned database without those files 404s every imported ride. The destination is dropped and replaced, so it is backed up first and the undo command is printed. Prod as a _destination_ additionally requires `--force`; every destination requires typing its name.

> **Compose derives its project name from the directory it runs in**, and the volume prefix from that. Renaming a checkout therefore orphans the database: the stack comes back up on a brand-new empty volume while the rows sit in the old one, and the container name collides rather than failing cleanly. `docker-compose.yml` pins `name: routeloop` so the local prefix no longer depends on the path. The deployed stacks set `COMPOSE_PROJECT_NAME` explicitly for the same reason—which also means a stale volume from an earlier era can be silently adopted by a fresh deploy. Check `docker volume ls` before assuming a new environment is empty.

> **Note on the `maps` → `rides` rename.** When the deploy still ran `drizzle-kit push`, this could not be resolved non-interactively. Production sidestepped it by being redeployed onto a fresh, empty database, so it is settled there. Any older database that still has a `maps` table needs `DROP TABLE IF EXISTS maps CASCADE;` before a deploy will succeed. Renames are still the sharp edge under generated migrations—the differ writes a drop plus an add unless you rewrite the file—but it is now a diff you read before it runs, not a prompt nobody sees.

## Provenance

RouteLoop reuses the client-side map engine from the original [Moto-Rooter](https://github.com/feralcreative/moto-rooter) static viewer. The backend was rebuilt PHP/MySQL → TypeScript + Hono + PostgreSQL, then the product pivoted from file upload to the in-app ride builder. The rendering behavior, mileage math, and waypoint taxonomy were ported forward; the upload path survives as import.
