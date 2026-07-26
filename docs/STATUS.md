# Status and Handoff

**Updated:** 2026-07-24
**Repo:** `/Users/ziad/www/moto/routeloop` on branch `feat/auth` (source of
truth — everything below is uncommitted)
**For:** the next agent picking up development

Read [\_AI_AGENT_PRIMER.md](../_AI_AGENT_PRIMER.md) first for architecture, then
this doc for where things stand. The current build plan is
[\_PLANS/routeloop-route-builder-pivot.md](../_PLANS/routeloop-route-builder-pivot.md);
the live session handoff (most precise resume point) is
[\_PLANS/routeloop-pivot-handoff.md](../_PLANS/routeloop-pivot-handoff.md).

## TL;DR

routeloop is a ride **planning / sharing / organizing** app (not navigation). It
pivoted from "upload KML files" to "**plan rides in-app on Mapbox**"; upload is
now an import path.

- **Stack:** TypeScript + Hono + PostgreSQL (Drizzle), Zod. Node in Docker.
- **Maps:** Mapbox GL JS + Directions + Geocoding, client-side, public token.
- **Hosting:** Synology NAS (`feral-nas`) behind Cloudflare Tunnel.

**State of the pivot (uncommitted — the entire pivot, the rename, and the auth
rebuild are all in the working tree on `feat/auth`):**

- **Auth** — done (Cloudflare Access → local server sessions). Sign-in is open to
  `ziad@feralcreative.co` only; everyone else is denied at the edge. See "Where
  we left off" below.
- **Phase 1** (data model + roles + structured import) — done, verified.
- **Phase 2** (Mapbox ride builder + native viewer + ride API) — done, verified
  in a real browser: plan a snapped route, classify stops, save, view.
- **Phase 3** (drag-to-shape + KML/GPX export) — next.

## Where we left off (2026-07-24, session ended on a quota error)

The last session did four things beyond the pivot, in this order. Read this
before assuming anything in the older sections is still accurate.

**1. Auth was rebuilt on Cloudflare Access.** Direct Google/GitHub OAuth is gone
— `src/auth/oauth.ts` deleted, `arctic` uninstalled, `.env.example`,
`docker-compose.prod.yml`, and `utils/deploy/deploy.sh` cleaned of the OAuth
variables. New code is `src/auth/access.ts` (email-header bridge, dev fallback,
`isAllowedOrigin`) and a rewritten `src/routes/auth.ts`. The `provider` enum
gained `cloudflare`.

**2. The app was renamed `tankbag` → `routeloop`.** Every in-repo reference,
filename, cookie name, package/deploy/database identifier, plan filename, and
brand asset. The local directory is now
`/Users/ziad/www/moto/routeloop`. The owner renames the git remote separately.

**3. Production was cut over by replacement, not migration.** A stray leftover
"rootloop" Express app was occupying `routeloop.app` on `:16703`. Both it and the
old tankbag stack were composed down and archived to
`/volume1/web/_retired/*-20260724T205817`, and this repo was deployed fresh.
This is why the `maps` → `rides` landmine no longer applies to prod: the
database is new and empty.

```text
container   routeloop            healthy, 127.0.0.1:16703 + :6686  → :6686
container   routeloop-db         healthy, EMPTY at cutover
container   routeloop-stage      healthy, 127.0.0.1:6687  + :16687 → :6686
container   routeloop-stage-db   healthy, schema applied
tunnel      routeloop.app        → localhost:16703
tunnel      tankbag.app          → localhost:6686    (same container; 301s away)
tunnel      stage.routeloop.app  → localhost:6687
tunnel      stage.tankbag.app    → localhost:16687   (same container; 301s away)
DNS         routeloop.app        proxied CNAME → feral-nas tunnel
DNS         stage.routeloop.app  proxied CNAME → feral-nas tunnel
```

Verified live: `/` → 302 → `/login` (200); `tankbag.app/m/abc?x=1` → 301 →
`routeloop.app/m/abc?x=1`; favicon, manifest, and Mapbox all serve correctly.

**4. The Cloudflare Access application was created.** The session hit a quota
error before the API response could be confirmed, but **it did land.**
Application `RouteLoop Login`, id `252ee150-1024-4c0a-b3ae-2a9592af25ea`,
destination `routeloop.app/auth/cloudflare`, 24h session. Confirmed enforcing:
that URL 302s to `feralcreative.cloudflareaccess.com` and a forged
`Cf-Access-Authenticated-User-Email` never reaches the origin. It was created
with no policy at first; see the allowlist section below.

### Sign-in is open to one address (2026-07-24)

The application was briefly left with **no** policy, which default-denied
everyone — including the owner, who then could not sign in with
`ziad@feralcreative.co`. That was the empty policy list working as configured,
not a fault. An Allow policy now exists:

```text
Policy   RouteLoop Owner  ·  c353c663-f8b3-45d8-b4db-b64cb4721c10
Include  email = ziad@feralcreative.co
```

That is the entire allowlist. Widening it means adding addresses to that
policy's `include` array; `print.ezzat.com` carries the fuller "ZR Personal
Projects" list and is the natural template. See
[cloudflare-access.md](cloudflare-access.md).

The project's contact address is a separate, still-undecided question ("some
other email"). No code depends on it: there is no `mailto:`, contact link, or
support address in the app today, and the only email in the source is the local
dev seed user.

### The remaining open items

1. **Widen the Cloudflare API token.** It can manage Access apps, tunnel config,
   and DNS, but `access/identity_providers` returns `10000 Authentication
   error`, so the Google login method was never confirmed. Add **Access:
   Organizations, Identity Providers, and Groups — Read**. Worth doing now so the
   information is on hand whenever sign-in is opened.
2. ~~Decide what to do about stage.~~ **Done 2026-07-25.** The old
   `tankbag-stage` stack was composed down and archived to
   `/volume1/web/_retired/stage.tankbag.app-20260724T222421` (it held 1 user,
   1 map, 376K of storage — seed-grade), freeing `:6687`. A full routeloop stage
   was then scaffolded: DNS, tunnel ingress, Access app + policy, and a deployed
   stack with the schema applied.
3. **Re-check the Mapbox token restrictions** (see Known risks — it currently
   answers every origin).
4. **Commit.** Nothing here is committed, the tree is large, and production was
   deployed from it with `--force`. Ask first.

None of these block Phase 3, which can be picked up now.

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
cd /Users/ziad/www/moto/routeloop
npm install
cp .env.example .env          # fill in MAPBOX_TOKEN (+ GMAPS_KEY for imports, DEV_AUTH_EMAIL)
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
./utils/deploy/prod.sh --dry-run    # preview
./utils/deploy/prod.sh              # routeloop.app :16703 (+ :6686 alias)
./utils/deploy/stage.sh             # stage.routeloop.app :6687 (+ :16687 alias)
```

`deploy.config` now carries an **alias port** per environment
(`PROD_ALIAS_HOST_PORT=6686`, `STAGE_ALIAS_HOST_PORT=16687`) so one container can
answer both its own tunnel route and the surviving legacy one. `MAPBOX_TOKEN` was
added to the deploy env plumbing (`.env` → remote `.env` →
`docker-compose.prod.yml`) at the same time; it was missing before and would have
shipped a broken map.

- [deploy.config](../deploy.config) — committed, secret-free, selects prod vs
  stage values.
- `.env` — secrets (`MAPBOX_TOKEN`, `GMAPS_KEY`, `PROD_DB_PASSWORD`,
  `STAGE_DB_PASSWORD`, Cloudflare token). Gitignored; see
  [.env.example](../.env.example). The prod Mapbox token must be URL-restricted
  to `routeloop.app` / `stage.routeloop.app`.
- [docker-compose.prod.yml](../docker-compose.prod.yml) — app + Postgres,
  published on `127.0.0.1` only. `deploy.sh` ships it to the NAS as
  `docker-compose.yml` plus a chmod-600 `.env`.
- [utils/deploy/deploy-utils.sh](../utils/deploy/deploy-utils.sh) — `logs`,
  `status`, `restart`, `psql`, `migrate`, `db-backup`, `backup`. Prefix with
  `DEPLOY_ENV=stage` for staging.

The tunnel routes `routeloop.app` → `localhost:16703` and the legacy
`tankbag.app` → `localhost:6686` (both the same container); there is no
`stage.routeloop.app` route yet. cloudflared runs natively on the Synology host.
The deploy
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
the gates but never the confirmation prompt). The 2026-07-24 production deploy
used `--force`, because the whole pivot is uncommitted on `feat/auth` — so
**what is running in production does not correspond to any commit.** Committing
this tree is the only thing that makes the deploy reproducible.

### Known risks in the deploy path

- **`maps` → `rides` rename — fully resolved.** The post-deploy `drizzle-kit
  push` runs non-interactively and cannot resolve a table rename; it needs a TTY
  prompt and will hang/fail. Both environments dodged it by being deployed onto
  brand-new empty databases rather than migrated, and the old stacks that held a
  `maps` table are archived under `/volume1/web/_retired/`. Only relevant again
  if one of those archives is ever restored — drop the table first.
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
- **Mapbox deploy plumbing — done (2026-07-24).** `MAPBOX_TOKEN` now flows
  `.env` → remote `.env` → `docker-compose.prod.yml`, mirroring `GMAPS_KEY`, and
  `deploy.sh` fails fast if it is missing.
- **The Mapbox token appears to have no URL restrictions.** A style request made
  with `Referer` set to `localhost`, `routeloop.app`, `stage.routeloop.app`, and
  `tankbag.app` returned **200 for all four** — so the token being shipped to the
  browser is usable from any site, and Mapbox usage is billable to this account.
  (Both prior notes claiming it was `localhost`-restricted are stale.) Confirm in
  the Mapbox dashboard and restrict it to `routeloop.app` +
  `stage.routeloop.app`, with a separate `localhost` token for dev. This is
  low-severity but real; it is not blocking anything.

## Next up

Sign-in works for the owner now, so nothing there gates the phase work. The
loose ends in "Where we left off" (token scope, stage, Mapbox restrictions,
committing the tree) are independent of it. Phase work:

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
