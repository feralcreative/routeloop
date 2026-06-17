# RouteLoop — Agent Briefing

Read this first. It explains where this repo came from, where it is going, and what to
reuse versus replace. It is a handoff for an agent starting with no prior context. Written
2026-06-16, at the moment the repo was created.

## TL;DR

`routeloop.app` is a **brand-new product** bootstrapped by copying a static motorcycle
route-map site (`moto.ezzat.com`). We kept that project's **map-rendering code and assets**
as a starting point and threw away its architecture. The goal is an **Angular + Firebase**
web app where people **register, save private routes, and share specific routes with
specific people (by email)**. Nothing for the new product has been built yet — the next job
is to plan the architecture, not to start editing the old files.

## Where this came from (history)

- This repo was **copied** on 2026-06-16 from `~/www/moto/moto.ezzat.com` (internally
  "Moto-Rooter"). It is **not a git fork** — the copy excluded `.git/`, and a fresh
  `git init` was run on branch `main` with **zero commits**. There is no shared history and
  no remote.
- The original is a **static site**: a Node/Express server (`server.js`) that uses Nunjucks
  only to inject a Google Maps API key into otherwise-static HTML, deployed as flat files to
  DreamHost behind Cloudflare. Each "ride" is a folder (`template/`, `demo/`, `vmc/...`,
  `2025/`, `2026/`) containing an `index.html` plus a `data/` directory of `routes.json` and
  `.kml` / `.gpx` / `.url` files. Vanilla JS in `js/main.js` fetches those files, parses the
  KML, draws polylines and role-based waypoint markers on Google Maps, computes mileage, and
  builds download buttons. There is no database, no accounts, no per-user anything.
- The original was mid-migration from Apache HTTP Basic Auth to **Cloudflare Access**. That
  effort belongs to the *old* repo and is **irrelevant here** — RouteLoop will use Firebase
  Authentication instead. You may see leftover artifacts (`.htpasswd`, `docs/cloudflare-access.md`);
  ignore them for auth purposes.

## Where we're going (product vision)

RouteLoop is a real multi-user app. Core capabilities:

- **Accounts** — users register and sign in (Firebase Authentication).
- **Private routes** — a signed-in user creates and saves routes that are private by
  default (stored in Firestore, owned by that user).
- **Sharing** — an owner can share a specific route with **specific people by email**;
  only those people (plus the owner) can view it.
- **Map experience** — routes render on a map with the same waypoint/marker/mileage richness
  the original had (reuse the existing Google Maps code).

## Tech direction (decided)

- **Frontend:** Angular (single-page app), most likely standalone components, with
  `@angular/fire` (AngularFire) for Firebase integration and `@angular/google-maps` to wrap
  the Maps JS API so the existing rendering logic ports in.
- **Auth:** Firebase Authentication.
- **Data:** Cloud Firestore for route metadata, ownership, and sharing. Raw uploaded files
  (`.kml` / `.gpx`) likely in Cloud Storage, with parsed geometry stored alongside in
  Firestore.
- **Hosting:** Firebase Hosting (replaces DreamHost). The Express/Nunjucks server and the
  build-time key-injection model are gone.

<!--| PAGE-BREAK -->

## What to reuse from the copied code

These are the reasons we copied rather than started empty — port them into Angular:

- **Map + KML logic** in `js/main.js`: `loadAllKmlRoutes`, the KML coordinate/placemark
  parsing, waypoint **role detection** (MEET, GAS, CHARGE, FOOD, CAMP, START, FINISH, etc.)
  and the per-role SVG icon selection, polyline drawing, the cumulative / since-gas /
  since-charge **mileage calculations**, and the route **color palette**.
- **Waypoint SVG icons** in `img/icons/` (designed for `fill="currentColor"` recoloring).
- **SCSS** in `style/` (panel, legend, tooltip, responsive styling).
- **GPX → Google Maps directions URL** converter in `utils/gpx-to-googlemap.py` (logic worth
  porting, even if reimplemented in TS).

## What is being replaced (prune candidates)

The Angular/Firebase rewrite makes these obsolete. Do **not** build on them:

- `server.js` (Express) and the Nunjucks `{{ GOOGLE_MAPS_API_KEY }}` injection.
- The per-folder static page model: `template/`, `demo/`, `2025/`, `2026/`, `vmc/`, and the
  large `_archive/` of old ride pages (most of the repo's 101M).
- The file-based data model (`routes.json` + loose `.kml`/`.gpx`/`.url`) → becomes Firestore
  documents (+ Storage).
- `utils/deploy/` (DreamHost rsync, hardcoded `DOMAIN="moto.ezzat.com"`), `.vscode/sftp.json`,
  `.htpasswd`, `logs/`, `.plans` / `_PLANS`.
- `.env` currently holds the **old project's live Google Maps key** — replace it with a new,
  HTTP-referrer-restricted key for `routeloop.app`, and surface it through Angular
  environment files, not a server.

## Inherited docs — treat as stale

`README.md` and `_AI_AGENT_PRIMER.md` describe the **old** static site. Trust them only for
**how the map/KML code works**; everything about architecture, deployment, auth, and data is
obsolete here. `docs/cloudflare-access.md` is inherited and not part of RouteLoop's auth plan.

## Current repo state

- Fresh `git init`, branch `main`, **0 commits**, no remote, nothing staged. Everything is
  untracked and uncommitted.
- Copy excluded: `.git/` history, the `.claude` symlink, `node_modules/`, `.DS_Store`.
- No Angular project scaffolding exists yet, no Firebase project is wired, no
  `firebase.json` / `firestore.rules` / `angular.json`.

## Open design decisions (plan these before coding)

1. **Firestore data model** — e.g. `routes/{routeId}` with `ownerUid`, route metadata,
   geometry storage strategy (coordinate arrays in the doc vs. raw file in Cloud Storage with
   a reference), and how waypoints are stored.
2. **Sharing-by-email security model** — the hard part. Firestore security rules authorize on
   `request.auth.uid`, but sharing targets **emails**. Rules *can* read
   `request.auth.token.email`, so one workable pattern is storing a `sharedWithEmails` array
   and matching the requester's verified email; consider invite-on-signup (email → uid)
   versus pure email matching, and the implications for unverified emails and revocation.
3. **Route ingestion** — upload `.kml` / `.gpx` and parse client-side with the ported code,
   draw-in-app, or both? This drives Storage usage and the parsing pipeline.
4. **Auth providers** — Google sign-in, email/password, or both; email verification policy.
5. **Maps key handling** — referrer-restricted client key via Angular environment config;
   confirm Maps JS API + geometry library still cover the ported features.
6. **App skeleton** — Angular version, standalone vs. modules, AngularFire setup, routing,
   and how the legacy vanilla-JS map code becomes an Angular service/component.

## Immediate next step

Produce an implementation **plan** covering the data model, the share-by-email security
rules, the Angular + Firebase skeleton, and the port of the map/KML code — then build. Do not
start by modifying the inherited static-site files; they are reference material, not the
foundation.
