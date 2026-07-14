# tankbag

tankbag (tankbag.app) is a web app for uploading, organizing, and sharing
motorcycle road-trip maps. Riders sign in, upload their route files, and get a
clean, interactive map they can share with a link — complete with per-stop icons
(gas, food, camp, meet), automatically calculated mileage, and
direction-of-travel indicators along each route.

It is being rebuilt from an earlier single-person, file-on-disk viewer (formerly
"Moto-Rooter") into a public, multi-tenant service. For deep technical onboarding
see [\_AI_AGENT_PRIMER.md](_AI_AGENT_PRIMER.md); for the build plan see
[\_PLANS/tankbag-hono-rebuild.md](_PLANS/tankbag-hono-rebuild.md).

## Status

Active rebuild on a **TypeScript + Hono + PostgreSQL** stack, hosted on a
Synology NAS behind a Cloudflare Tunnel. Delivered in phases:

- [x] **Phase 0** — Hono app scaffold, local dev server, viewer served
- [x] **Phase 1** — Postgres + Drizzle; a stored map renders end-to-end from the database
- [ ] **Phase 2** — Accounts (Google / GitHub sign-in, sessions, dashboard)
- [ ] **Phase 3** — Web upload UI, validation, and per-user storage quotas
- [ ] **Phase 4** — Public browse / discovery and shareable links
- [ ] **Phase 5** — Deploy to the NAS (Docker) on `tankbag.app` / `stage.tankbag.app`
- [ ] **Later** — PostGIS geo discovery; MapLibre migration

## What it does

The vision, and where each piece stands today:

- **Accounts** — sign in with Google or GitHub, no passwords to manage
  _(planned, Phase 2)_
- **Upload** — drag-and-drop `.kml` (required) and `.gpx` (optional) through the
  browser instead of over SSH _(planned, Phase 3)_
- **Storage** — every account gets a storage quota for its map files
  _(planned, Phase 3)_
- **Viewer** — interactive Google map with a colored route polyline, direction
  arrows, mileage, and typed waypoint markers with tooltips _(working)_
- **Sharing** — public, unlisted, or private visibility, shareable by link
  _(gating working; UI in Phase 4)_
- **Browse** — a public gallery of shared maps _(planned, Phase 4)_

## Tech stack

- **Backend** — TypeScript on Hono (runs on Node in Docker; portable to
  Cloudflare Workers), PostgreSQL via Drizzle ORM
- **Frontend** — vanilla JavaScript with the Google Maps JavaScript API; SCSS
  compiled to CSS
- **Bot defense** — Cloudflare Turnstile on sign-up and upload _(Phase 3)_
- **Hosting** — Synology NAS (Docker) behind a Cloudflare Tunnel; HTTPS at the
  Cloudflare edge

The map viewer is deliberately map-provider-agnostic apart from its rendering
calls; migrating to MapLibre later (to avoid Google Maps usage costs at scale)
would leave the KML parsing, waypoint model, and UI untouched.

## Local development

### Requirements

- Node.js 20+
- Docker (to run PostgreSQL locally)

### Setup

1. Install dependencies and start Postgres:

   ```bash
   npm install
   docker compose up -d --wait db
   ```

2. Create a git-ignored `.env` in the repo root:

   ```text
   PORT=6686
   GMAPS_KEY=<Google Maps browser key, restricted by HTTP referrer>
   STORAGE_PATH=./moto-storage
   DATABASE_URL=postgres://tankbag:tankbag_dev_pw@127.0.0.1:5432/tankbag
   ```

3. Apply the schema (defined in `src/db/schema.ts`) and seed a sample map:

   ```bash
   npx drizzle-kit push
   npx tsx src/db/seed.ts
   ```

4. Compile the styles if you changed the SCSS:

   ```bash
   npm run sass
   ```

### Run

```bash
npm run dev
```

Then open <http://127.0.0.1:6686> (use `127.0.0.1`, not `localhost`, to match the
Maps key's referrer allowlist). The seed map is at `/m/sample-route-one`.

## Project structure

```text
src/                  TypeScript app (Hono)
  index.ts            Routes, viewer/home templates, gated file streaming
  db/                 Drizzle schema, connection, dev seed
public/               Static assets, served directly
  js/main.js          The map viewer (vanilla JS)
  style/main.min.css  Compiled CSS
  img/                Icons, logos, assets
style/main.scss       SCSS source (compiled into public/style/)
docker-compose.yml    PostgreSQL for dev (app service at deploy time)
drizzle.config.ts     Drizzle Kit config
utils/schema.sql      Legacy MySQL schema (historical)
app/                  Legacy PHP implementation (superseded; reference only)
_PLANS/               Rebuild plans
```

User-uploaded map files live in a private `STORAGE_PATH` **outside** the web root
and are served only through an ownership / visibility check.

## How routes work

A map is defined by a `.kml` file (route geometry plus waypoints) and optional
`.gpx` (a downloadable GPS track) and an external route URL. The viewer parses
the KML, draws the longest coordinate path as the route, and turns every
placemark point into a typed waypoint marker.

### Waypoint types and icons

Name a waypoint in your mapping software with a type prefix so the viewer picks
the right icon:

```text
GAS - Chevron Station
```

Combine up to four types on one waypoint by separating them with `/`:

```text
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
| CAMP    | icon-camp.svg    | CAMPGROUND, CAMPING                 |
| HOTEL   | icon-hotel.svg   | LODGING, MOTEL, AIRBNB, SLEEP, STAY |
| FOOD    | icon-food.svg    | LUNCH, DINNER, BREAKFAST            |
| COFFEE  | icon-coffee.svg  | CAFE                                |
| DRINKS  | icon-drinks.svg  | BAR, COCKTAILS, BEER, BEERS         |
| GROCERY | icon-grocery.svg | GROCERIES                           |
| VIEW    | icon-view.svg    | SCENIC, LOOKOUT, VIEWPOINT          |
| POI     | icon-poi.svg     | STOP                                |
| WTF     | icon-wtf.svg     | WEIRD, RANDOM                       |

Icons live in `public/img/icons/` and were designed in
[this Figma document](https://www.figma.com/design/pFQck3CUIa5twKqMu1IxD5/moto-router).
Their fill is `currentColor` so each icon tints to match its route color.

### Route colors

Each map carries its own color. When a color is not set, the viewer falls back
to a palette in `public/js/main.js`:

| Hex       | Label      |
| --------- | ---------- |
| `#0000cc` | Blue       |
| `#cc0000` | Red        |
| `#8800DD` | Violet     |
| `#FF6F00` | Orange     |
| `#DD00DD` | Magenta    |
| `#006064` | Teal       |
| `#4A148C` | Purple     |
| `#4E342E` | Brown      |
| `#00aaaa` | Cyan       |
| `#0D1335` | Dark Blue  |
| `#A0740B` | Mustard    |
| `#003300` | Dark Green |
| `#550000` | Burgundy   |

## Deployment

Target host is a Synology NAS. The app runs as a Docker container (prod
`tankbag.app` on `:6686`, stage `stage.tankbag.app` on `:6687`) behind a
Cloudflare Tunnel; the tunnel routes and DNS are already configured, so a site
goes live as soon as its container is listening. PostgreSQL runs as a sibling
container. HTTPS terminates at Cloudflare's edge and no inbound ports are open on
the NAS. Full deployment steps land under Phase 5.

## Provenance

This app reuses the client-side map engine from the original Moto-Rooter static
viewer, recovered from git history and rewired to read from a database and
per-user storage instead of files on disk. The backend was first rebuilt in
PHP/MySQL (see `app/`, now superseded) and then re-based on TypeScript + Hono +
PostgreSQL. The rendering, mileage math, and waypoint model are unchanged;
everything around them — accounts, upload, storage, sharing — is new.
