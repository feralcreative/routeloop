# Moto-Rooter

Moto-Rooter is a web app for uploading, organizing, and sharing motorcycle
road-trip maps. Riders sign in, upload their route files, and get a clean,
interactive map they can share with a link — complete with per-stop icons (gas,
food, camp, meet), automatically calculated mileage, and direction-of-travel
indicators along each route.

It is being rebuilt from an earlier single-person, file-on-disk viewer into a
public, multi-tenant service. For deep technical onboarding see
[\_AI_AGENT_PRIMER.md](_AI_AGENT_PRIMER.md); for the full build plan see
[\_PLANS/multi-tenant-rebuild.md](_PLANS/multi-tenant-rebuild.md).

## Status

Active rebuild on a PHP + MySQL (LAMP) stack, delivered in milestones:

- [x] **M0** — Restructure into a `public/` web root and app skeleton
- [x] **M1** — A stored map renders end-to-end from the database
- [ ] **M2** — Accounts (Google / GitHub sign-in)
- [ ] **M3** — Web upload UI, validation, and per-user storage quotas
- [ ] **M4** — Public browse / discovery and shareable links
- [ ] **M5** — DreamHost deployment

## What it does

The vision, and where each piece stands today:

- **Accounts** — sign in with Google or GitHub, no passwords to manage
  _(planned, M2)_
- **Upload** — drag-and-drop `.kml` (required) and `.gpx` (optional) through the
  browser instead of over SSH _(planned, M3)_
- **Storage** — every account gets a storage quota for its map files
  _(planned, M3)_
- **Viewer** — interactive Google map with a colored route polyline, direction
  arrows, mileage, and typed waypoint markers with tooltips _(working)_
- **Sharing** — public, unlisted, or private visibility, shareable by link
  _(gating working; UI in M4)_
- **Browse** — a public gallery of shared maps _(planned, M4)_

## Tech stack

- **Backend** — PHP 8.3 and MySQL, on a minimal hand-rolled front controller (no
  heavy framework); Composer is used only for OAuth
- **Frontend** — vanilla JavaScript with the Google Maps JavaScript API; SCSS
  compiled to CSS
- **Bot defense** — Cloudflare Turnstile on sign-up and upload
- **Hosting** — DreamHost shared hosting

The map viewer is deliberately map-provider-agnostic apart from its rendering
calls; migrating to MapLibre later (to avoid Google Maps usage costs at scale)
would leave the KML parsing, waypoint model, and UI untouched.

## Local development

### Requirements

- PHP 8.1+ with the `pdo_mysql`, `dom`, `libxml`, and `curl` extensions
- MySQL or MariaDB
- Node.js (only to compile SCSS via the `sass` package)
- Composer (only once OAuth lands in M2)

### Setup

1. Create the database and load the schema:

   ```bash
   mysql -e "CREATE DATABASE moto_rooter CHARACTER SET utf8mb4;"
   mysql moto_rooter < utils/schema.sql
   ```

2. Create a local config (git-ignored) from the template and fill in values:

   ```bash
   cp config.example.php config.local.php
   ```

   At minimum set the `db` block, a `gmaps_key` (a Google Maps browser key,
   restricted by HTTP referrer), and `storage_path`.

3. Compile the styles:

   ```bash
   npm install
   npm run sass
   ```

### Run

The app serves everything through `public/index.php`. For local dev, use the
PHP built-in server with the bundled router shim:

```bash
php -S 127.0.0.1:6686 -t public public/router.php
```

Then open <http://127.0.0.1:6686>. A public map is viewable at `/m/{slug}`.

## Project structure

```text
public/          Web root (the only web-served directory)
  index.php      Front controller
  .htaccess      Rewrite + hardening (Apache / DreamHost)
  js/main.js     The map viewer (vanilla JS)
  style/         Compiled CSS
  img/           Icons, logos, assets
app/             Application code (not web-served)
  Router.php  Db.php  Config.php  bootstrap.php
  Controllers/   PageController, PublicController (+ Auth/Map later)
  views/         PHP templates
utils/           schema.sql, migrations, maintenance scripts
style/main.scss  SCSS source (compiled into public/style/)
_PLANS/          The rebuild plan
config.example.php   Config template (copy to config.local.php for dev)
```

User-uploaded map files live in a private `storage_path` **outside** the web
root and are served only through an ownership / visibility check in PHP.

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

Target host is DreamHost shared hosting (PHP + MySQL). The domain's web
directory points at `public/`; secrets (`config.php`) and user files
(`storage_path`) live outside the web root and outside git. HTTPS is provided by
DreamHost's free Let's Encrypt certificates. Full deployment steps are in the
rebuild plan under milestone M5.

## Provenance

This app reuses the client-side map engine from the original Moto-Rooter static
viewer, recovered from git history and rewired to read from a database and
per-user storage instead of files on disk. The rendering, mileage math, and
waypoint model are unchanged; everything around them — accounts, upload,
storage, sharing — is new.
