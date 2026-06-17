# Plan: Rewrite README.md for RouteLoop

## Context

The repo at `/Users/ziad/www/moto/routeloop` was created today (2026-06-16) by copying the old static motorcycle-map site `moto.ezzat.com` (internally "Moto-Rooter"). The product direction has changed completely: RouteLoop is a brand-new multi-user web app (Angular + Firebase) where people register, save private routes, and share specific routes with specific people by email. The inherited `README.md` and `_AI_AGENT_PRIMER.md` still describe the old static site and are stale. The user asked to rewrite `README.md` to reflect both the current state and the future plans.

What I verified on disk (this matters because the briefing overstates what was copied):

- `routeloop` is a fresh `git init`, branch `main`, 0 commits, no remote, everything untracked.
- Only design assets came over: `img/icons/` (22 waypoint SVGs), `img/colors/` (13 swatch PNGs), logos (`vmc-logo.*`, `vmc-patch.svg`), `crater-lake.jpg`, `style/main.scss` (441 lines, panel/legend/tooltip/route-table styling), a minimal `index.html` shell, `favicon.ico`, `manifest.json`, plus `img/screenshot.png`.
- The map/KML logic the briefing tells us to "reuse" is NOT here. `js/main.js`, `utils/gpx-to-googlemap.py`, `utils/`, `data/`, the ride folders (`2025/`, `2026/`, `vmc/`, `template/`, `demo/index.html`), `_archive/`, `docs/`, and `.htpasswd` are all absent. They still live in the source repo `~/www/moto/moto.ezzat.com` (`js/main.js` is 1,175 lines there).
- No Angular/Firebase scaffolding yet: no `angular.json`, `firebase.json`, `firestore.rules`, `src/`, `tsconfig.json`. `package.json` is still `moto-ezzat-map` with only `express`/`nunjucks`/`dotenv`. The old `server.js` is present and now obsolete.

User decisions (via clarifying questions):

1. Map code: treat as a fresh rewrite. Do not document the old JS as present. Map features are described as being rebuilt in Angular, with a one-line pointer to the source repo for reference.
2. Reference detail: keep everything, reframed under RouteLoop (waypoint/icon tables, color palette, z-index, roadmap), dropping obsolete server/deploy specifics.
3. Voice/audience: polished, public product README for routeloop.app.

Reconciliation note: "public product README" vs. "0 commits, nothing built" is a real tension. The rewrite leads with a product-forward pitch but carries an honest, prominent Status section so it satisfies the current-state requirement without pretending the product ships today.

## Approach

Full rewrite of `/Users/ziad/www/moto/routeloop/README.md` as a polished, product-forward README for routeloop.app, honest about early-development status. Reframe the inherited reference material under RouteLoop; drop everything tied to the old static-site architecture.

### Section outline (new README)

1. H1 `RouteLoop` + tagline + a short product pitch (register, save private routes, share specific routes with specific people by email). Keep the existing screenshot (`img/screenshot.png` exists). Add an "early development" status badge line. No fabricated live-demo link; mark routeloop.app as coming soon.
2. Status. Honest current state: pre-release; foundation being built on Angular + Firebase. What exists today (inherited design system and assets) vs. what is next. This carries the "current state" requirement.
3. Features. Product-forward capability list: accounts (Firebase Auth), private-by-default routes (Firestore), share-by-email, and the rich map experience (role-based waypoints, mileage including since-gas/since-charge, GPX/KML/URL downloads). Map capabilities are phrased as being (re)built in Angular.
4. How it works / Architecture. Angular SPA, `@angular/fire`, `@angular/google-maps`, Firestore for route metadata/ownership/sharing, Cloud Storage for raw `.kml`/`.gpx`, Firebase Hosting. This is the "future plans" content from the briefing.
5. Roadmap. Phased plan reframed from the briefing's open decisions plus the old "harebrained ideas" backlog: Phase 0 scaffold Angular + Firebase; Phase 1 port map rendering; Phase 2 auth; Phase 3 private routes; Phase 4 share-by-email. Backlog: mailto route files, social share/embed, club logo/banner, multi-page nav.
6. Waypoint types and icons. Reframed standard + custom waypoint tables (all 22 icons are present in `img/icons/`), the naming convention (`TYPE - Name`, `TYPE1/TYPE2 - Name`), the `currentColor` recoloring note, and the Figma icon-doc link.
7. Route colors. Default color palette table (13 swatches present in `img/colors/`).
8. Design system reference (legacy, for the port). The z-index table and SCSS color variables, clearly labeled as inherited from the legacy implementation and kept as reference for the Angular port, so they do not clash with the product voice.
9. Branding / logos. Customizing `panel-logo` and `map-logo`, reframed.
10. Getting started (planned). Target dev workflow: Angular CLI (`ng serve`) + Firebase emulators, referrer-restricted Maps key via Angular environment files. Clearly marked "once the app is scaffolded." One-line note that the legacy Express/Nunjucks `server.js` is reference-only and will be removed.
11. Credits / acknowledgments. Ported from moto.ezzat.com; Figma icon doc; routeloop.app. One-line pointer: the original vanilla-JS map implementation lives in `~/www/moto/moto.ezzat.com/js/main.js` and serves only as reference for the Angular rewrite.

### Drop from the old README

Moto-Rooter naming; Synology NAS / PM2 deploy; the `/demo/` drop-a-kml workflow; `build.sh`; the `routes.json` file model; the old live-demo link (`moto-rooter.feralcreative.dev`); the Express/dotenv API-key-injection setup as primary instructions; and the function-level "Main Components" section (`initMap`, `loadKmlRoute`, etc.), since the map code is a fresh rewrite.

### Add

Status / early-development framing; Angular + Firebase architecture; the share-by-email concept; the phased roadmap.

### Markdown conventions to honor

Single H1; ATX headings with correct increments; blank lines around headings, lists, and fences; a language tag on every fenced block (`text` when nothing else fits); no multiple consecutive blank lines; single trailing newline. No `---` horizontal rules (per global rule); rely on heading hierarchy. Do not hard-wrap prose (one line per paragraph/bullet). No spaced em dashes. Use relative asset paths (`img/icons/...`, `img/colors/...`). Prefer markdown image syntax `![alt](path)` over inline `<img>` for MD033 compliance, accepting default icon sizing (trade-off: the old README used `<img width/height>` for exact sizing).

### Files

- Edit: `/Users/ziad/www/moto/routeloop/README.md` (full rewrite).
- Per user convention, also drop an identical copy of this plan in a repo-root `_PLANS/` folder during execution (plan mode blocks creating it now).
- Out of scope, flag only (not changing unless asked): `package.json` name (`moto-ezzat-map`), `manifest.json` (`App`), and the still-stale `_AI_AGENT_PRIMER.md`. Recommend a follow-up to reconcile these.

## Verification

- Re-read the finished README against on-disk reality: no claim references a file that is absent (no `js/main.js`, `data/`, `routes.json`, demo pages presented as present).
- Confirm every referenced asset path exists: `img/screenshot.png`, `img/icons/*.svg`, `img/colors/*.png`, and the logo assets.
- Lint-check by eye against the markdown rules: every fence has a language, no `---` rules, single H1, single trailing newline, blank lines around blocks.
- Open the README preview in the IDE to confirm tables and images render correctly (SVG icons via markdown image syntax, PNG swatches).
