# Status and Handoff

**Updated:** 2026-07-23
**Repo:** `tankbag-app` (source of truth)
**For:** the next agent picking up development

Read [\_AI_AGENT_PRIMER.md](../_AI_AGENT_PRIMER.md) first for architecture, then
this doc for where things stand. The current build plan is
[\_PLANS/tankbag-route-builder-pivot.md](../_PLANS/tankbag-route-builder-pivot.md);
the live session handoff (most precise resume point) is
[\_PLANS/tankbag-pivot-handoff.md](../_PLANS/tankbag-pivot-handoff.md).

## TL;DR

tankbag is a ride **planning / sharing / organizing** app (not navigation). It
pivoted from "upload KML files" to "**plan rides in-app on Mapbox**"; upload is
now an import path.

- **Stack:** TypeScript + Hono + PostgreSQL (Drizzle), Zod. Node in Docker.
- **Maps:** Mapbox GL JS + Directions + Geocoding, client-side, public token.
- **Hosting:** Synology NAS (`feral-nas`) behind Cloudflare Tunnel.

**State of the pivot (uncommitted — entire pivot is in the working tree):**

- **Auth** — done (Google/GitHub OAuth, sessions, dashboard).
- **Phase 1** (data model + roles + structured import) — done, verified.
- **Phase 2** (Mapbox ride builder + native viewer + ride API) — done, verified
  in a real browser: plan a snapped route, classify stops, save, view.
- **Phase 3** (drag-to-shape + KML/GPX export) — next.

> A prior deploy (2026-07-20) put the **pre-pivot** app on stage + prod. The
> current working tree is well ahead of what is deployed, and a redeploy needs
> the `maps` → `rides` migration step (see Known risks).

## What is built

Backend is the Hono app in [src/index.ts](../src/index.ts) plus route modules in
[src/routes/](../src/routes/); schema is
[src/db/schema.ts](../src/db/schema.ts) (source of truth). Data model:
`users`, `user_identities`, `sessions`, `rides`, `routes`, `points`,
`route_legs` (see the primer for columns).

Public read path:

- `GET /` — public ride listing
- `GET /m/:slug` — viewer (native → Mapbox shell; imported → legacy Google shell)
- `GET /api/public/rides/:slug/ride.json` — normalized viewer contract
- `GET /api/public/maps/:slug` + `/kml` + `/gpx` — legacy metadata + gated file
  streams (imported rides; retire in Phase 4)

Owner path (`requireAuthApi` + `requireSameOrigin`): `POST /api/maps` (import),
`POST`/`PUT`/`GET /api/rides` (builder), `PATCH`/`DELETE /api/maps/:id`, plus the
`/builder` pages.

Security invariants carried from the PHP build and still enforced: XXE-safe KML
parse (reject `<!DOCTYPE>`), text sanitization at rest, transactional quota
(413), the visibility gate returning 404 for private/unknown slugs, integer-id
containment-checked file paths, and the `Origin` CSRF gate.

## Local development

Postgres runs in Docker; the app runs on the host with hot reload.

```bash
cd /Users/ziad/www/moto/tankbag-app
npm install
cp .env.example .env          # fill in MAPBOX_TOKEN (+ GMAPS_KEY for imports, OAuth)
docker compose up -d --wait db
npx drizzle-kit push          # apply schema
npx tsx src/db/seed.ts        # demo user + sample ride (structured rows)
npm run dev                   # http://localhost:6686
```

Port 6686 is this project's designated port — kill and reuse it if busy, never
switch ports.

Notes:

- **Browse dev at `http://localhost:6686`, not `127.0.0.1`** — the Mapbox dev
  token is `localhost`-restricted; tiles/Directions/geocoding 403 from the raw
  IP. `APP_ORIGIN` stays `127.0.0.1`, but `isAllowedOrigin` accepts both dev
  hosts, so the CSRF gate passes either way. (Imported-ride viewing still uses
  the Google key, referrer-locked to `127.0.0.1` — a wrinkle that dies in
  Phase 4.)
- Root [docker-compose.yml](../docker-compose.yml) is **local-dev only**
  (Postgres). The deployed stack is `docker-compose.prod.yml`.
- The seed reads `moto-storage/1/1.{kml,gpx}` and extracts structured rows from
  the KML.
- `public/style/main.min.css` is a gitignored build artifact — run
  `npm run sass` locally, or let the Docker build compile it.
- npm is used in practice (`package-lock.json`), not pnpm.

## Deploy — NAS + Cloudflare Tunnel

Deploy tooling follows **archetype B (Docker-on-NAS templated)** from
`.claude/docs/DEPLOY_SCRIPT_INSTRUCTIONS.md`.

```bash
./utils/deploy/stage.sh --dry-run   # preview
./utils/deploy/stage.sh             # stage.tankbag.app :6687
./utils/deploy/prod.sh              # tankbag.app :6686
```

- [deploy.config](../deploy.config) — committed, secret-free, selects prod vs
  stage values.
- `.env` — secrets (`MAPBOX_TOKEN`, `GMAPS_KEY`, `PROD_DB_PASSWORD`,
  `STAGE_DB_PASSWORD`, Cloudflare token). Gitignored; see
  [.env.example](../.env.example). The prod Mapbox token must be URL-restricted
  to `tankbag.app` / `stage.tankbag.app`.
- [docker-compose.prod.yml](../docker-compose.prod.yml) — app + Postgres,
  published on `127.0.0.1` only. `deploy.sh` ships it to the NAS as
  `docker-compose.yml` plus a chmod-600 `.env`.
- [utils/deploy/deploy-utils.sh](../utils/deploy/deploy-utils.sh) — `logs`,
  `status`, `restart`, `psql`, `migrate`, `db-backup`, `backup`. Prefix with
  `DEPLOY_ENV=stage` for staging.

The tunnel routes `tankbag.app` → `localhost:6686` and `stage.tankbag.app` →
`localhost:6687`; cloudflared runs natively on the Synology host. The deploy
scripts never touch tunnel config.

**The app container runs as the host uid, not the image's `node` user.**
`data/storage` lives on a Synology share whose ACL grants rwx to `ziad` (1026)
and r-x to `users` (100), but nothing to uid 1000 — so the container could
stream metadata yet returned 404 for every KML/GPX read. Synology's
`synoacltool` refuses to add an ACE for a bare numeric uid with no passwd
record, so the fix is `user: "${APP_UID}:${APP_GID}"` in
`docker-compose.prod.yml`, fed from `APP_UID`/`APP_GID` in `deploy.config`. The
symptom if NAS permissions change: a working ride list with silently 404-ing
route files.

The prod deploy refuses a dirty tree or a non-`main` branch (`--force` overrides
the gates but never the confirmation prompt).

### Known risks in the deploy path

- **`maps` → `rides` rename (pivot branch).** The post-deploy `drizzle-kit push`
  runs non-interactively and cannot resolve a table rename — it needs a TTY
  prompt and will hang/fail. **Before the first deploy of this branch, run**
  `DROP TABLE IF EXISTS maps CASCADE;` on the stage and prod databases (their
  data is seed-grade; accepted in the plan).
- The Docker image runs `tsx` (a devDependency) as its entrypoint, so it
  installs dev dependencies deliberately. `--omit=dev` would not boot.
- Schema is applied with `drizzle-kit push --force`, not generated migrations —
  no `drizzle/` directory. The post-deploy hook is non-fatal; re-run with
  `deploy-utils.sh migrate`.
- The Postgres password is read only when the data volume first initialises.
  Changing it later requires `ALTER USER` in the db container.
- A fresh deploy has an **empty database** — a working but empty ride list until
  seeded.
- The verify step runs **before** the post-deploy schema push, so a first-ever
  deploy logs `App not responding yet` and a Postgres "relation does not exist"
  error before recovering. Cosmetic.
- Prod and stage share one DB password; both volumes are initialised, so
  changing it means `ALTER USER` in each container.
- **Mapbox** must be added to the deploy env plumbing before deploy (`.env` →
  remote `.env` → `docker-compose.prod.yml`), mirroring how `GMAPS_KEY` is
  handled today. Confirm this wiring exists before shipping Phase 5.

## Next up

1. **Phase 3 — Shaping + export.** Drag-to-shape legs into `route_legs.via_points`;
   `src/maps/export.ts` (`buildKml` / `buildGpx` via `formatRoleName`);
   source-aware `/kml` + `/gpx` (native = generated); flip native
   `kmlUrl`/`gpxUrl` in `ride.json` from null to real URLs.
2. **Phase 4 — Unify viewer + retire Google.** Backfill structured rows for
   pre-pivot rides; `/m/:slug` always Mapbox; delete `main.js`, the legacy
   metadata endpoint, and `GMAPS_KEY`; add the dashboard import UI.
3. **Phase 5 — Trip features.** Multi-day rides + the timeline slider.
4. **Near-term UX** from [\_PLANS/changes-260724T0250Z.md](../_PLANS/changes-260724T0250Z.md):
   title-as-placeholder, role multi-select dropdown, splash/login + home page
   (recent 10 + popular 10 rides), logo.

## Conventions and guardrails

- **Never commit, push, or deploy without the owner's explicit permission.**
  Hand over a terse commit message instead. No AI co-author attribution.
- **SCSS** compiles with `npm run sass` (the `sass` CLI), never an IDE
  extension. Source `style/main.scss` → `public/style/main.min.css`.
- **Utility scripts** go in `utils/`; **docs** (besides README and primer) in
  `docs/`.
- **Don't re-couple viewers to the filesystem.** Native rides render from
  `ride.json`; the legacy viewer reads its API seams.
- Preserve the security invariants listed above when adding write paths.
- Follow the owner's markdown rules: fenced blocks need a language, no `---`
  horizontal rules, blank lines around headings, lists, and code.
