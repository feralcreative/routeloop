# Status and Handoff

**Updated:** 2026-07-19
**Repo:** `tankbag-app` (source of truth)
**For:** the next agent picking up development

Read [\_AI_AGENT_PRIMER.md](../_AI_AGENT_PRIMER.md) first for architecture, then
this doc for exactly where things stand. The current build plan is
[\_PLANS/tankbag-hono-rebuild.md](../_PLANS/tankbag-hono-rebuild.md).

## TL;DR

tankbag is a public, multi-tenant motorcycle route-map sharing app. Two pivots
have happened since the original plan, and both are committed:

- **Stack:** TypeScript + Hono + PostgreSQL (Drizzle), not PHP + MySQL.
- **Hosting:** Synology NAS (`feral-nas`) behind Cloudflare Tunnel, not
  DreamHost. Node is fine now — it runs in a container on our own hardware.

Phase 0 and Phase 1 are built. The Phase 5 deploy tooling was added early (on
2026-07-19) so the app can be pushed to the NAS, but **it has never been run**.

## Superseded documents

These describe the original PHP/MySQL/DreamHost build. Keep them for the
security reasoning and the viewer port notes; ignore them on stack and hosting.

- [\_PLANS/multi-tenant-rebuild.md](../_PLANS/multi-tenant-rebuild.md) — the
  original plan. Its upload-pipeline and security sections are still the spec
  to port from.
- `app/`, `composer.json`, `config.*.php`, `utils/schema.sql` — retired PHP
  build, still on disk, excluded from the Docker image via `.dockerignore`.

## What is built

The backend is a single Hono app in [src/index.ts](../src/index.ts) serving the
public read path, with the Drizzle schema in
[src/db/schema.ts](../src/db/schema.ts):

- `GET /` — public map listing
- `GET /m/:slug` — viewer page (injects `window.MOTO` + the Maps key)
- `GET /api/public/maps/:slug` — metadata JSON (viewer seam 1)
- `GET /api/public/maps/:slug/kml` — gated KML stream (seam 2)
- `GET /api/public/maps/:slug/gpx` — gated GPX download

Schema tables: `users`, `user_identities`, `maps` — translated from the MySQL
design, including the `size_bytes` generated column and the browse index.

The security invariants carried over from the PHP build: the visibility gate
returns 404 for private/unknown slugs (never confirms existence), file paths are
built only from integer ids and containment-checked against `STORAGE_PATH`, and
`esc()` escapes user-derived strings before they reach HTML.

**Not yet verified in a browser on this stack.** The PHP version was
browser-verified at M1; the Hono port has not been re-confirmed here. Do that
before trusting the viewer end to end.

## Local development

Postgres runs in Docker; the app runs on the host with hot reload.

```bash
cd /Users/ziad/www/moto/tankbag-app
npm install
cp .env.example .env          # then fill in GMAPS_KEY
docker compose up -d --wait db
npx tsx src/db/seed.ts        # one demo user + one public map
npm run dev                   # http://127.0.0.1:6686
```

Port 6686 is this project's designated port. Do not start a server on a
different port if it is busy — kill the existing process and reuse 6686.

Notes:

- The root [docker-compose.yml](../docker-compose.yml) is **local-dev only**
  (Postgres alone). The deployed stack is `docker-compose.prod.yml`.
- The seed expects the sample KML/GPX already at `moto-storage/1/1.{kml,gpx}`.
- `public/style/main.min.css` is a gitignored build artifact — run
  `npm run sass` locally, or let the Docker build compile it.
- The plan proposed pnpm; npm was used in practice (`package-lock.json`).

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
- `.env` — secrets (`GMAPS_KEY`, `PROD_DB_PASSWORD`, `STAGE_DB_PASSWORD`,
  Cloudflare token). Gitignored; see [.env.example](../.env.example).
- [docker-compose.prod.yml](../docker-compose.prod.yml) — app + Postgres,
  published on `127.0.0.1` only. `deploy.sh` ships it to the NAS as
  `docker-compose.yml` plus a chmod-600 `.env` that supplies its variables.
- [utils/deploy/deploy-utils.sh](../utils/deploy/deploy-utils.sh) — `logs`,
  `status`, `restart`, `psql`, `migrate`, `db-backup`, `backup`. Prefix with
  `DEPLOY_ENV=stage` for staging.

The tunnel already routes `tankbag.app` → `localhost:6686` and
`stage.tankbag.app` → `localhost:6687`; cloudflared runs natively on the
Synology host. **Both hostnames return 502 until the app is deployed** — that is
expected, not a fault. The deploy scripts never touch tunnel config.

The prod deploy refuses a dirty tree or a non-`main` branch (`--force`
overrides the gates but never the confirmation prompt).

### Known risks in the deploy path

- The Docker image runs `tsx` (a devDependency) as its entrypoint, so the image
  installs dev dependencies deliberately. `--omit=dev` would produce an image
  that cannot boot.
- Schema is applied with `drizzle-kit push --force`, not generated migrations —
  there is no `drizzle/` directory. The post-deploy hook is non-fatal; re-run
  with `deploy-utils.sh migrate`.
- The Postgres password is read only when the data volume first initialises.
  Changing it later requires `ALTER USER` inside the db container, not a
  redeploy.
- A fresh deploy has an **empty database**. Expect a working but empty map list
  until data is seeded or uploaded.

## Next up

1. Run `./utils/deploy/stage.sh` and confirm `stage.tankbag.app` serves the
   viewer end to end. Staging skips the prod gates, so prove the chain there
   first.
2. **Phase 2 — Auth.** Lucia (or Auth.js) with Google + GitHub OAuth, server
   sessions, `/login`, `/auth/*`, `/logout`, dashboard shell. Needs OAuth
   credentials only the owner can create: redirect URIs
   `http://127.0.0.1:6686/auth/{provider}/callback` for dev, plus the
   `tankbag.app` equivalents for prod.
3. **Phase 3 — Upload + quota.** Port the PHP pipeline: Turnstile, XXE-safe
   parse rejecting `<!DOCTYPE>`, KML sanitization, server-side metadata
   extraction, transactional quota. Re-derive these rather than skipping them.
4. **Phase 4 — Browse + share.**

## Conventions and guardrails

- **Never commit, push, or deploy without the owner's explicit permission.**
  Hand over a terse commit message instead.
- **SCSS** compiles with `npm run sass` (the `sass` CLI), never an IDE
  extension. Source `style/main.scss` → `public/style/main.min.css`.
- **Utility scripts** go in `utils/`; **docs** (besides the README and primer)
  go in `docs/`.
- **Don't re-couple the viewer to the filesystem.** `public/js/main.js` reads
  from the API via `window.MOTO.metadataUrl` and the `/kml` endpoint.
- Preserve the security invariants listed above when adding write paths.
- Follow the owner's markdown rules in docs: fenced blocks need a language, no
  `---` horizontal rules, blank lines around headings, lists, and code.
