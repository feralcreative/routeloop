# tankbag

tankbag (tankbag.app) is a web app for **planning, organizing, and sharing**
motorcycle rides and car road trips. Riders build a route on an interactive
Mapbox map — dropping stops, classifying them (gas, food, camp, lodging,
scenic…), with the road route snapped between them — then manage it, share it by
link, and export it. Existing route files (KML, GPX) can be imported to migrate
in.

It is deliberately a **planning and sharing tool, not a turn-by-turn navigation
app**. The problem it solves: Google My Maps caps at ~10 waypoints and one route
per layer and can't be used to navigate — tankbag has no such limits and gives a
holistic view of an entire multi-day trip. For deep technical onboarding see
[\_AI_AGENT_PRIMER.md](_AI_AGENT_PRIMER.md); the vision is in
[docs/ideas.md](docs/ideas.md); the build plan is
[\_PLANS/tankbag-route-builder-pivot.md](_PLANS/tankbag-route-builder-pivot.md).

## Status

Active build on a **TypeScript + Hono + PostgreSQL** stack with a **Mapbox**
front end, hosted on a Synology NAS behind a Cloudflare Tunnel. The product
recently pivoted from "upload KML files" to "plan rides in-app"; upload is now an
import path. Delivered in phases:

- [x] **Auth** — Google / GitHub sign-in, server sessions, dashboard
- [x] **Data model** — rides → routes → stops/POIs → routed legs; role taxonomy
- [x] **Import** — KML/GPX upload → a structured, editable-model ride
- [x] **Ride builder** — plan a snapped route on Mapbox, classify stops, save
- [x] **Native viewer** — shared rides render on Mapbox from the database
- [ ] **Shaping + export** — drag routes into shape; export KML/GPX _(next)_
- [ ] **Unify + retire Google** — one Mapbox viewer; drop the legacy viewer
- [ ] **Trip features** — multi-day rides and the timeline slider
- [ ] **Later** — bikes/rider profiles, more import formats, PostGIS discovery

## What it does

- **Plan** — build a route on a Mapbox map: click or search to add stops, and
  the road route is snapped between them. Classify each stop with the 17-role
  taxonomy (gas, food, camp, meet, scenic…).
- **Organize** — a ride packages one or more routes (days/sessions); stops,
  points of interest, and ephemeral shaping waypoints are distinct.
- **Share** — public, unlisted, or private visibility, shareable by link.
- **Import** — bring in existing `.kml` / `.gpx` to migrate from other tools
  _(KMZ, CSV later)_.
- **Export** — download a ride as KML/GPX for other apps / round-tripping
  _(next phase)_.
- **Accounts** — sign in with Google or GitHub; each account has a storage quota
  for imported files.

## Tech stack

- **Backend** — TypeScript on Hono (Node in Docker; portable to Cloudflare
  Workers), PostgreSQL via Drizzle ORM, Zod validation.
- **Maps** — Mapbox GL JS (rendering) + Mapbox Directions (per-leg road routing)
  + Mapbox Geocoding v6 (search), called client-side with a URL-restricted
  public token. Loaded from the Mapbox CDN — the front end has no bundler.
- **Auth** — `arctic` OAuth (Google + GitHub) with hand-rolled server sessions;
  Cloudflare Turnstile guards uploads/saves (feature-flagged).
- **Hosting** — Synology NAS (Docker) behind a Cloudflare Tunnel; HTTPS at the
  Cloudflare edge.

> A legacy Google Maps viewer (`public/js/main.js`) still renders **imported**
> rides during the transition; it and its `GMAPS_KEY` are removed once the
> Mapbox viewer is unified across both sources.

## Local development

### Requirements

- Node.js 20+
- Docker (to run PostgreSQL locally)
- A Mapbox account with a public token

### Setup

1. Install dependencies and start Postgres:

   ```bash
   npm install
   docker compose up -d --wait db
   ```

2. Create a git-ignored `.env` from `.env.example` and fill it in. The essential
   dev keys:

   ```text
   PORT=6686
   MAPBOX_TOKEN=pk.<public token>
   STORAGE_PATH=./moto-storage
   DATABASE_URL=postgresql://tankbag:tankbag_dev_pw@127.0.0.1:5432/tankbag
   APP_ORIGIN=http://127.0.0.1:6686
   ```

   The Mapbox public token needs only the default public scopes (styles, fonts);
   Directions and Geocoding work on any public token. In dev, either leave its
   URL restrictions empty or restrict to `localhost` (Mapbox rejects IP
   addresses). For production, restrict it to `tankbag.app` and
   `stage.tankbag.app`.

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

Then open <http://localhost:6686>. **Use `localhost`, not `127.0.0.1`** — the
Mapbox dev token is restricted to `localhost`, and Mapbox tiles/Directions/
geocoding return 403 from the raw IP. (The one exception: viewing an *imported*
ride uses the legacy Google viewer, whose key is referrer-locked to `127.0.0.1`.
This split goes away when the Google viewer is retired.) The seed ride is at
`/m/sample-route-one`; the builder is at `/builder`.

## Project structure

```text
src/                  TypeScript app (Hono)
  index.ts            Home, viewer (native Mapbox / imported Google), ride.json,
                      legacy metadata + gated file streams
  db/                 Drizzle schema (source of truth), connection, dev seed
  auth/               Sessions, middleware, OAuth (arctic)
  maps/               roles.ts, kml.ts, storage.ts, slug.ts, turnstile.ts
  routes/             maps.ts (import), rides.ts (builder), dashboard.ts, auth.ts
  views/layout.ts     Shared chrome shell
public/
  js/main.js          Legacy Google Maps viewer (imported rides only)
  js/map-common.js    Shared Mapbox engine
  js/viewer.js        Native ride viewer
  js/builder.js       The ride builder
  style/main.min.css  Compiled CSS
  img/icons/          17 role SVGs (currentColor) + UI icons
style/main.scss       SCSS source
docker-compose.yml    PostgreSQL for dev (app service at deploy time)
drizzle.config.ts     Drizzle Kit config
docs/ideas.md         Product vision
_PLANS/               Plans + session handoff
app/, utils/schema.sql  Legacy PHP/MySQL (superseded; reference only)
```

Imported files live in a private `STORAGE_PATH` **outside** the web root, served
only through an ownership / visibility check. Native rides are pure database
rows.

## The data model

- **Ride** — the shareable package (slug, visibility, title): holds many routes.
- **Route** — one day/session: an ordered list of stops joined by road-snapped
  legs, with an optional start/end date-time.
- **Points** come in two kinds: **Stops** (ordered routing anchors, can carry a
  duration) and **POIs** (unordered annotations that don't affect routing).
  Ephemeral **shaping waypoints** are stored on the leg, not as points.
- **Legs** carry the snapped geometry and Directions distance/duration between
  consecutive stops. Imported rides are stored as one route with a single
  full-track leg, so imported and native rides render through one code path.

## Waypoint roles (classification, import & export)

Stops and POIs are classified with a 17-role taxonomy defined canonically in
`src/maps/roles.ts`. In the builder you pick roles from icons; on **import** the
`ROLE - Name` name-prefix convention is parsed into roles, and on **export** it
is written back so files round-trip through other tools (Google Earth, etc.).

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

Icons live in `public/img/icons/`, designed in
[this Figma document](https://www.figma.com/design/pFQck3CUIa5twKqMu1IxD5/moto-router).
Their fill is `currentColor` so each icon tints to match its route color.

## Deployment

Target host is a Synology NAS. The app runs as a Docker container (prod
`tankbag.app` on `:6686`, stage `stage.tankbag.app` on `:6687`) behind a
Cloudflare Tunnel; tunnel routes and DNS are already configured. PostgreSQL runs
as a sibling container. HTTPS terminates at Cloudflare's edge and no inbound
ports are open on the NAS.

> **Before the first deploy of the pivot branch:** the schema renamed `maps` →
> `rides`. The post-deploy `drizzle-kit push` runs non-interactively and cannot
> resolve a table rename, so drop the old table first:
> `DROP TABLE IF EXISTS maps CASCADE;` on the stage and prod databases.

## Provenance

tankbag reuses the client-side map engine from the original Moto-Rooter static
viewer, recovered from git history. The backend was rebuilt PHP/MySQL →
TypeScript + Hono + PostgreSQL, then the product pivoted from file upload to the
in-app Mapbox ride builder. The rendering behavior, mileage math, and waypoint
taxonomy were ported forward; the upload path survives as import.
