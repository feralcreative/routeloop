# routeloop

Multi-tenant motorcycle ride planner (TypeScript + Hono + Postgres), live in production at `routeloop.app`. Plan a multi-day ride on one map, share it by link, hand it off to Google Maps, import and export six formats.

## Rules of engagement

This section outranks everything else in this file and everything in the codebase.

**Ask, do not infer.** The comments here are unusually dense and explain how something ended up. They are history, not policy. A comment saying a form avoids fetch+JSON is not a ban on fetch. If something looks like a rule and it is not written in this file, ask.

**Offer options, do not pick silently.** When there is a real choice—a library, an approach, a shape—lay out two or three candidates with trade-offs and let Ziad choose.

**These are NOT constraints.** All four were inferred from the code by an agent and all four were wrong (confirmed 2026-08-09): no-JavaScript / progressive enhancement; vanilla JS with no bundler; zero dependencies; tests must not need a database. Use as much client JS as the job needs, propose a build step or a framework if it earns its place, add a useful dependency rather than reinventing it, write a database-backed test when that is the honest test.

**These are real.** The `ride > day > leg > stop/POI` hierarchy is settled and not to be re-litigated. **Alternate** joins it as of 2026-08-16: two or more days grouped as candidates for the same stretch, exactly one of them active. Not "variant", not "option". American English everywhere in code, comments, copy and docs (`color`, not `colour`; the SCSS token `$grey` keeps its spelling because it is an identifier). Never commit, push or deploy without being asked, and never put AI attribution in a commit message or PR body.

**Open, and Ziad's call:** whether `public/js/map-common.js` remaining the only file that calls `google.maps` is enforced policy or just where it landed. It is currently intact. Ask before either enforcing or breaking it.

**The standing preference:** best practices, but not at the cost of the thing working. A library, script or framework that genuinely earns its keep is judged on its merits.

## Commands

| Task | Command |
| --- | --- |
| Install | `npm install` |
| Postgres (dev) | `docker compose up -d --wait db` |
| Apply migrations | `npm run db:migrate` |
| Generate a migration | `npm run db:generate` (after editing `src/db/schema.ts`) |
| Baseline a pre-`drizzle/` database | `npm run db:baseline` |
| Seed | `npx tsx src/db/seed.ts` (one sample ride) or `utils/seed-dev.sh` |
| Dev server | `npm run dev` (SCSS watch + `tsx watch` + live reload, port 6686) |
| Dev server, no SCSS watcher | `npm run dev:server` |
| Unit tests | `npm test` |
| Single test file | `npx vitest run test/roles.test.ts` |
| Tests, watching | `npm run test:watch` |
| Typecheck | `npm run typecheck` |
| Compile CSS | `npm run sass` |
| Prose dash check / fix | `npm run check:dashes` / `npm run fix:dashes` |
| Regenerate the favicon set | `node utils/build-favicons.mjs` (needs `rsvg-convert`; writes all eight files in `public/img/favicon/`) |
| Enable the pre-commit hook (once per clone) | `git config core.hooksPath .githooks` |

`npm run dev` runs `db:migrate` first via `predev`. Port 6686 belongs to this project: if it is bound, kill what holds it and reuse the port—never start on another one.

**Node 24**, pinned in `.node-version` so fnm and nvm switch to it on `cd`. It is the same major the Dockerfile ships and the upper half of the CI matrix; `engines` in `package.json` is a floor of 22 and only warns, so the pin is what actually gets you on the right runtime. There is no `.nvmrc`—both tools read `.node-version`, and a second file is a second thing to forget to bump.

## Definition of done

Run these, in order, and pass them before reporting work complete:

1. `npm run typecheck`
2. `npm test`
3. `npm run sass`—only if you touched `style/`
4. `npm run check:dashes`—only if you touched prose

Not required, and do not attempt: there is no e2e suite, no browser suite and no database-backed suite. `vitest.config.ts` is deliberately scoped to pure logic under `test/`, which is why CI needs no Postgres service. CI runs typecheck and tests on Node 22 and 24 for every PR and every push to `main`—the `engines` floor and the version the Dockerfile ships.

Anything touching the map, the builder or an import needs a manual browser pass as well—nothing automated covers those.

## Prohibitions

- **Never commit, push or deploy without being asked.** Deploys go to a live site riders have accounts on.
- **Never add AI attribution** to a commit message or PR body—no `Co-Authored-By`, no generated-with footer.
- **Never hand-edit:** `public/style/main.min.css` (run `npm run sass`), `drizzle/*.sql` after it has been applied anywhere, `drizzle/meta/` (written by `db:generate`), `package-lock.json` (`npm install`).
- **Never add new SQL to `utils/deploy/sql/`.** Those dated files are the `push`-era record of what ran against production and stay as history. New schema work goes through `npm run db:generate` into `drizzle/`.
- **Never lint or compile SCSS through an IDE extension.** `npm run sass`, and fix lint findings in code rather than with a CLI autofixer.
- **Never read `.env`, `storage/`, `_PLANS/` or any `*.sql.gz` into a commit, a log or a chat response.** All are gitignored and hold credentials, rider files or database dumps.
- **Read the generated SQL before applying a migration**, and rewrite it when the differ guessed wrong. A rename comes out as a drop plus an add; a `NOT NULL` on a populated column needs a backfill ahead of it. Riders hold data that cannot be rebuilt from an upload.
- **Human approval required** for: any schema change, any new dependency, anything touching prod or stage, and removing the `map-common.js` boundary.

## Architecture

Vocabulary is law: **ride > day > leg > stop/POI**. A ride is the shareable package (slug, visibility, title). A day is one day within it, a position rather than a calendar date. A leg is the routed path from stop *i* to stop *i+1*. Three kinds of dots: a **stop** is a routing anchor (`points.kind = 'stop'`, ordered), a **POI** is near the route and does not affect routing (`points.kind = 'poi'`), a **waypoint** is an ephemeral shaping point stored as `route_legs.via_points` and never a row in `points`. "Route" means only a path, or a route *file* from another app. Not "trip", not "map".

Request path:

1. `src/index.tsx`—host middleware first, redirecting the `LEGACY_HOSTS` names 301 to the canonical host before any route or auth handler runs.
2. Static assets from `public/`, then `withSession` resolves the session once per request.
3. Route modules mounted at `/` from `src/routes/*`—see [docs/api.md](docs/api.md).
4. Gates from `src/auth/middleware.ts`: `requireAuth`/`requireAuthApi`, `requireActive`/`requireActiveApi` (`users.status`), `requireSameOrigin` (CSRF), `requireManageRiders`, `requireSurvey`.
5. Ride writes normalize and insert through `insertRideGraph` in `src/maps/ride-graph.ts`—the builder's save and the native JSON import share it, so a second path cannot drift.
6. Drizzle → Postgres. `src/db/schema.ts` is the source of truth.

Boundaries that matter:

- `public/js/map-common.js` (`window.TBMap`) is the only file that calls `google.maps`. `viewer.js` and `builder.js` go through the handles it returns and name no vendor API.
- Six pure client helpers own arithmetic rather than DOM and are `eval`'d by their own tests: `ride-time.js`, `twist.js`, `route-shape.js`, `builder-history.js`, `duration.js`, `alternates.js`.
- `src/maps/alternates.ts` is the single source of truth for what an alternate day means, mirrored by `public/js/alternates.js` and pinned together by `test/alternates.test.ts`. Both runtimes have to agree: the builder decides live which day is active and what the ride's mileage reads, and the server decides the same thing on save. A disagreement shows up as a builder displaying one total while the database stores another, with nothing raised.
- `src/maps/roles.ts` is the single source of truth for the 17 waypoint roles; the `waypoint_role` enum in `src/db/schema.ts` and the icons in `public/img/icons/` must stay in sync with it.
- `src/maps/filename.ts` is the source of truth for the export filename convention; `public/js/filename.js` mirrors it and `test/filename-client.test.ts` holds the two together. Same arrangement for `twist.ts`/`twist.js` and for `duration.ts`/`duration.js`—the last of those has a third copy to keep in step, `fmtDuration()` in `src/routes/roadbook.tsx`, which `test/duration.test.ts` also pins.
- Anything server-side that must be tested with no database is split rule-from-query: `src/invites/policy.ts` vs `service.ts`, `src/survey/score.ts` vs `questions.ts`, `src/stats/shape.ts` vs `query.ts`.
- **One third-party script loads from a CDN, on the builder only:** SortableJS 1.15.7 from jsdelivr, for drag-to-reorder, pinned with an SRI hash and `crossorigin`. Approved 2026-08-15. It is not a mistake and not leftover—but note the builder degrades rather than breaks if it fails to load, and every row menu carries Move up / Move down as both the fallback and the keyboard path. Keep both properties if you touch it. Self-hosting the webfonts was a decision about **fonts**, not a general ban on CDNs.

Deeper: [docs/architecture.md](docs/architecture.md).

## Conventions

- **Coordinates are `[lng, lat]`** everywhere in this app—storage, payloads, GeoJSON, exports.
- **Formatting is prettier**, configured in `.prettierrc`. Do not argue with it; note that `public/js/**` and SCSS have deliberate per-glob overrides.
- **Prose is never hard-wrapped.** One line per paragraph, soft-wrapped by the editor. Em dashes are tight (`word—word`); use a spaced en dash when a line wants air. The pre-commit hook fixes and re-stages.
- **Views are Hono JSX** (`jsxImportSource: hono/jsx`, no React, no bundler). JSX escapes by default; `raw()` is the opt-out.
- **Tests are Vitest under `test/`**, named `*.test.ts`, pure logic only.
- **Schema changes ship as generated migrations** committed alongside the `schema.ts` change—SQL and `drizzle/meta/` both.
- **Branches** are `type/kebab-subject`; commits are Conventional Commits.

## Gotchas

Things an agent gets wrong by default. This section is why the file exists.

- **A document that disagrees with the code loses.** That has happened repeatedly here and has already caused a GitHub issue to be filed for finished work. Look at the files before believing any checklist.
- **`[lng, lat]` vs `{lat, lng}`.** Only `google.maps` speaks `{lat, lng}`, and exactly two places convert: `toLatLng`/`fromLatLng` in `public/js/map-common.js`, and `toGoogleWaypoint` in `src/routes/routing.ts`. A transposed pair still renders, just in the wrong hemisphere. GeoJSON agrees with us—do not "fix" it. Pinned by `test/round-trip.test.ts`.
- **Only active days count, and there is no single place that enforces it.** `rideTotals()` covers the stored caches, `loadRideForExport()` covers every lossy export and the roadbook and the hand-off page, five predicates in `src/stats/query.ts` cover the dashboard, and `ride-time.js` and the builder's own readout cover the two clients. A new surface that sums days has to opt in. `loadNativeRide()` and `loadRidePayload()` deliberately do the opposite and keep every day—they are the lossless paths.
- **`ride-time.js` skips losing alternates INSIDE the module, never by filtering the array at a call site.** `activeAtMoment()` returns `dayIndex`, which both clients feed straight back into `state.days[i]` and `setLegHighlight(map, i, …)`. Hand it a filtered array and every index past the first ghost is off by one, silently, and the map highlights the wrong road.
- **`null` is not zero.** Twistiness `null` means nothing measured it; `0` means the road is straight. Same for `dist_from_start_m` on a trackless import. A format that guesses is indistinguishable from one that knows.
- **`rides.size_bytes` must name every byte column.** The app increments `users.used_bytes` on import and the database decrements it from `size_bytes` on delete, so a column missing from that generated expression leaks quota on every delete, silently and permanently.
- **`.tb-marker` is deliberately `0×0`** in `style/_map.scss`. An `AdvancedMarkerElement` anchors its content at bottom-center, so a zero-size wrapper puts the anchor on the point and the negative-margin offsets keep working. Give it a size and every marker drifts.
- **A day is drawn as one polyline**, the concatenated geometry of all its legs, with the duplicate vertex dropped at each joint and no indices consumed by an empty leg. Turning a drag index back into a leg plus a via-point slot is the entire job of `public/js/route-shape.js`. Do not switch to one polyline per leg—the layer-id contract every caller depends on assumes otherwise.
- **The zip download route is registered ahead of the generic `:format` route on purpose** in `src/index.tsx`. Registered after it, the generic route swallows `/zip/gpx` and answers with a plain GPX. Observed, not theorised.
- **The `routeloop_` filename marker is load-bearing.** `parseExportName` returns `null` without it, so a rider's own `day-2.gpx` is never reinterpreted. Underscores separate fields and hyphens live inside one; do not simplify the separator. Dates are formatted and parsed in UTC because the roadbook renders `days.start_at` with `timeZone: 'UTC'`.
- **Two brand names are read where one is written, and that is permanent.** `READ_MARKERS` in `src/maps/filename.ts` accepts `tankbag_` alongside `routeloop_`, `COMPOUND_EXTS` accepts `.tankbag.json`, `nativeVersion()` in `src/maps/export.ts` reads either version key, and `/api/public/maps/:slug/tankbag.json` is still routed. None of that is leftover debris from the rename—it is what keeps every file a rider already downloaded importable, and dropping it fails silently: the files still import, just stripped of the day order and dates that GPX and KML cannot carry internally. `public/js/filename.js` mirrors all of it. Tidying any of it away needs a decision, not a cleanup pass.
- **A filename is not a format.** It carries four fields and the date is the one doing the work, because GPX and KML cannot hold a schedule. Resist adding roles, colors or dwell to it.
- **The pre-commit tightener rewrites em dashes in test fixtures too.** `test/em-dashes.test.ts` was once committed comparing strings to themselves because of it.
- **`utils/` is not in `tsconfig.json`.** `npm run typecheck` does not cover it, and a bad import there fails only at runtime. Check a `utils/` change by hand:

  ```bash
  npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler \
    --types node --esModuleInterop --skipLibCheck utils/seed-demo-rides.ts
  ```

- **`test/` is in `tsconfig.json` on purpose.** Vitest transpiles without type-checking, so removing it hides fixture drift. Keep it there.
- **The builder's snapshot shares what is never mutated in place, and that set changes.** `leg.geometry` is shared by reference because it is always replaced wholesale; `point.roles` must be copied because `splice()` mutates it. `leg.viaPoints` moved between the two groups the day drag-to-shape shipped and nothing failed loudly. Re-check whenever you add an edit-in-place feature.
- **Empty days are dropped at save time.** The API requires at least one stop per day, so `payload()` in `builder.js` filters empty days rather than failing the whole ride.
- **The production code is not precious. The production database is.** Nobody has been let into the beta and nobody will be for a long time, so downtime, a broken deploy and overwritten code all cost approximately nothing—only the splash page and signup need to keep working. The rows are the opposite: `users` now holds real outside signups sitting at `status = 'pending'`, and those records are not reconstructable. Take a `db-backup` before anything that could touch the volume, and treat `docker compose down -v`, a `$DOMAIN` change and a stale-volume adoption as the three ways to lose them. Nothing in the app prunes a pending user, so the only risk is operational.
- **Be careful with how a migration runs, not about whether to do one.** Deferring a schema change out of caution once shipped imports that destroyed multi-day structure.

## Credentials

`.env.example` is the canonical, annotated list of every key. Copy it to `.env` and fill it in. Never write a secret value—in whole, in part, or masked—into this file, `docs/`, a log or a chat response.

| Variable | Source | Notes |
| --- | --- | --- |
| `GMAPS_KEY` | `.env` | Browser key, referrer-restricted. Ships in page source by design |
| `GMAPS_SERVER_KEY` | `.env` | Server key, IP-restricted. Routes + Geocoding. Must never reach a client |
| `GMAPS_MAP_ID` | `.env` | Vector Map ID. Advanced Markers render nothing without it |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | `.env` | OAuth client. See [docs/google-cloud-setup.md](docs/google-cloud-setup.md) |
| `SMTP_*`, `MAIL_FROM` | `.env` | Outbound mail. See [docs/email.md](docs/email.md) |
| `DATABASE_URL`, `APP_ORIGIN`, `PORT`, `STORAGE_PATH` | `.env` | Local dev values are in `.env.example` |
| `DEV_LOGIN_EMAIL` | `.env` | Local only; the route is not registered unless four conditions hold |
| `PROD_DB_PASSWORD`, `STAGE_DB_PASSWORD` | `.env` | Read by `utils/deploy/deploy.sh` for the matching environment |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`, `CLOUDFLARE_ACCOUNT_ID` | `.env` | Cache purge on deploy |

The deploy writes the server's `.env` from an explicit allow-list in `utils/deploy/deploy.sh`. A new required key that is not added to that list reaches no environment, and the container still starts and passes its healthcheck.

## Commit and PR conventions

- Conventional Commits: `type(scope): subject`, imperative mood. Types in use: `feat`, `fix`, `refactor`, `docs`, `chore`, `style`, `test`. Scope optional, welcome when it clarifies.
- Branch as `type/kebab-subject`—`feat/trip-timeline-slider`, `fix/multi-track-import`.
- Hand over a single chained one-liner (`git add -A && git commit -m "…"`) and let Ziad run it. Do not commit unasked.
- Before opening a PR: `npm run typecheck`, `npm test`, and `npm run sass` if SCSS changed. Link the issue it closes. A fix for something the tests missed should come with the test that would have caught it.
- Never commit: `.env`, compiled CSS, `storage/`, `_PLANS/`, database dumps.

## Deep-dive index

- [docs/architecture.md](docs/architecture.md)—map engine, builder rules, module boundaries, the import security pipeline. Read before cross-cutting or client-side changes.
- [docs/api.md](docs/api.md)—every endpoint, its gate, and the ride payload shape. Read before adding or changing a route.
- [docs/database.md](docs/database.md)—tables, enums, and the generate/migrate/baseline workflow. Read before touching `src/db/schema.ts`.
- [docs/deployment.md](docs/deployment.md)—NAS, Docker, tunnel topology, and the traps each deploy has hit. Read before deploying or changing deploy scripts.
- [docs/debugging.md](docs/debugging.md)—known failure modes by symptom. Read when something is broken and the cause is not obvious.
- [docs/decisions.md](docs/decisions.md)—why the key choices were made and what was rejected. Read before undoing something deliberate.
- [docs/email.md](docs/email.md)—mail subsystem, templates, dark mode, delivery setup.
- [docs/google-cloud-setup.md](docs/google-cloud-setup.md)—obtaining and restricting the three Google credentials.
- [docs/ideas.md](docs/ideas.md)—the product vision, and what this app deliberately is not.
- [docs/STATUS.md](docs/STATUS.md)—what has just changed. Moves fastest, goes stale fastest; the code outranks it.

## Maintenance

When a change makes anything in this file inaccurate—a command, a path, a convention, a prohibition—update this file in the same change.
