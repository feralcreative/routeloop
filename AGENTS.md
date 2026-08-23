# routeloop

Multi-tenant motorcycle ride planner (TypeScript + Hono + Postgres), live in production at `routeloop.app`. Plan a multi-day ride on one map, share it by link, hand it off to Google Maps, import and export six formats.

## Rules of engagement

This section outranks everything else in this file and everything in the codebase.

**Ask, do not infer.** The comments here are unusually dense and explain how something ended up. They are history, not policy. A comment saying a form avoids fetch+JSON is not a ban on fetch. If something looks like a rule and it is not written in this file, ask.

**Offer options, do not pick silently.** When there is a real choice—a library, an approach, a shape—lay out two or three candidates with trade-offs and let Ziad choose.

**These are NOT constraints.** All four were inferred from the code by an agent and all four were wrong (confirmed 2026-08-09): no-JavaScript / progressive enhancement; vanilla JS with no bundler; zero dependencies; tests must not need a database. Use as much client JS as the job needs, propose a build step or a framework if it earns its place, add a useful dependency rather than reinventing it, write a database-backed test when that is the honest test.

**These are real.** The `ride > day > leg > stop/POI` hierarchy is settled and not to be re-litigated. The **alt** joins it as of 2026-08-16: two or more days grouped as candidates for the same stretch, exactly one of them active. **In code it is `alt` and `alts`**—identifiers, filenames, columns, types. Ziad's call, 2026-08-16. **What it is called on a rider-facing surface is deliberately unconstrained**, so "alternative", "alternate" or anything else is fine in copy and is not a defect; do not file one, and do not "fix" copy to match the identifiers. American English everywhere in code, comments, copy and docs (`color`, not `colour`; the SCSS token `$grey` keeps its spelling because it is an identifier). Never commit, push or deploy without being asked, and never put AI attribution in a commit message or PR body.

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

Vocabulary is law: **ride > day > leg > stop/POI**. A ride is the shareable package (slug, visibility, title). A day is one day within it, a position rather than a calendar date. A leg is the routed path from stop *i* to stop *i+1*. Three kinds of dots: a **stop** is a routing anchor (`points.kind = 'stop'`), a **POI** is near the route and does not affect routing (`points.kind = 'poi'`), a **waypoint** is an ephemeral shaping point stored as `route_legs.via_points` and never a row in `points`. "Route" means only a path, or a route *file* from another app. Not "trip", not "map".

**A day is ONE ORDERED LIST of points and `kind` is a flag on each, not a choice of which list to put it in.** Ziad's call, 2026-08-23. Every point carries `position`, both kinds, dense from 0; `day.points` in the client and the payload; `stopsOf()` on both sides is the only bridge to the leg math, which still counts in stops because a leg joins stop *i* to stop *i+1*. **Every user-created point starts as a POI**—a map click, either search arm, a saved place—and is promoted from the row menu. **The exception is the first point of a day, which is promoted on the spot and tagged `start`**, which is what keeps "at least one stop per day" true without the rider being asked. The consequence to state rather than treat as a bug: a day of three POIs draws three dots and no road, because there is nothing to route between.

Request path:

1. `src/index.tsx`—host middleware first, redirecting the `LEGACY_HOSTS` names 301 to the canonical host before any route or auth handler runs.
2. Static assets from `public/`, then `withSession` resolves the session once per request.
3. Route modules mounted at `/` from `src/routes/*`—see [docs/api.md](docs/api.md).
4. Gates from `src/auth/middleware.ts`: `requireAuth`/`requireAuthApi`, `requireActive`/`requireActiveApi` (`users.status`), `requireSameOrigin` (CSRF), `requireManageRiders`, `requireSurvey`.
5. Ride writes normalize and insert through `insertRideGraph` in `src/maps/ride-graph.ts`—the builder's save and the native JSON import share it, so a second path cannot drift.
6. Drizzle → Postgres. `src/db/schema.ts` is the source of truth.

Boundaries that matter:

- `public/js/map-common.js` (`window.TBMap`) is the only file that calls `google.maps`. `viewer.js` and `builder.js` go through the handles it returns and name no vendor API.
- Seven pure client helpers own arithmetic rather than DOM and are `eval`'d by their own tests: `ride-time.js`, `twist.js`, `route-shape.js`, `builder-history.js`, `duration.js`, `alts.js`, `feedback-buffer.js`.
- `src/maps/alts.ts` is the single source of truth for what an alternate day means, mirrored by `public/js/alts.js` and pinned together by `test/alts.test.ts`. Both runtimes have to agree: the builder decides live which day is active and what the ride's mileage reads, and the server decides the same thing on save. A disagreement shows up as a builder displaying one total while the database stores another, with nothing raised.
- `src/maps/roles.ts` is the single source of truth for the 17 waypoint roles; the `waypoint_role` enum in `src/db/schema.ts` and the icons in `public/img/icons/` must stay in sync with it.
- `src/maps/filename.ts` is the source of truth for the export filename convention; `public/js/filename.js` mirrors it and `test/filename-client.test.ts` holds the two together. Same arrangement for `twist.ts`/`twist.js` and for `duration.ts`/`duration.js`—the last of those has a third copy to keep in step, `fmtDuration()` in `src/routes/roadbook.tsx`, which `test/duration.test.ts` also pins.
- Anything server-side that must be tested with no database is split rule-from-query: `src/invites/policy.ts` vs `service.ts`, `src/survey/score.ts` vs `questions.ts`, `src/stats/shape.ts` vs `query.ts`, `src/feedback/policy.ts` vs `service.ts`.
- **`src/emails/` is pure and must stay that way.** Every module there is a function of its props and nothing else, which is what lets `test/emails.test.ts` import the whole registry with no database and no environment. Anything that reads a table to decide whether to send lives outside it—`src/auth/notify.ts` and `src/feedback/notify.ts` are the two precedents.
- **A saved place is COPIED into a ride, never referenced.** Ziad's call, 2026-08-21. There is deliberately no `place_id` on `points`: a ride is a record of what the rider planned, so renaming or deleting a place must not reach back and rewrite a ride from last year—and points churn on every save anyway, so a foreign key would have to survive that for no gain. `placeToStop()` in `src/places/policy.ts` is that decision in code, mirrored client-side by `stopFromPlace()` in `public/js/builder.js`. **The consequence to state rather than treat as a bug: fixing a badly placed pin fixes future rides only.** A place carries the DURABLE half of stop details (phone, address, links) and never the per-trip half—inheriting last September's confirmation number would be worse than having none.
- **`place_groups` deletes with `set null`, not cascade.** Deleting a group keeps its places and makes them ungrouped; `groupPlaces()` renders them in their own section. A rider tidying up a folder name must not lose their saved locations, which is exactly what cascade would do.
- **`src/maps/point-details.ts` is the private-stop-details boundary, and it is the only module that reads `point_details`.** Confirmation numbers, gate codes and phone numbers live in their own table rather than as columns on `points` for exactly one reason: `points` is what `ride.json` is built from and what every export serializes, so a private field stored there is one forgetful `select()` away from a public share. A separate table has to be JOINed to leak, and a join is visible in review. `canSeeDetails()` is the whole rule—**owner only, and deliberately blind to `visibility`**, because sharing a route is not sharing a reservation. Details reach exactly three surfaces: the builder's own load, `ride.json` for the owner, and the native JSON. They are stripped from GPX, KML, GeoJSON and CSV, and a clone drops them (`src/routes/builder.ts`)—a public ride is clonable by anyone.
- **`visibleTo()` in `src/feedback/policy.ts` is the private-bug feature.** There is no second mechanism: a report is invisible to everyone but its author and the owner until `state = 'published'`, and nothing publishes a bug by default. `state` (the owner's gate) and `status` (the rider-facing lifecycle) are two columns for exactly this reason.
- **One third-party script loads from a CDN, on the builder only:** SortableJS 1.15.7 from jsdelivr, for drag-to-reorder, pinned with an SRI hash and `crossorigin`. Approved 2026-08-15. It is not a mistake and not leftover—but note the builder degrades rather than breaks if it fails to load, and every row menu carries Move up / Move down as both the fallback and the keyboard path. Keep both properties if you touch it. Self-hosting the webfonts was a decision about **fonts**, not a general ban on CDNs.

Deeper: [docs/architecture.md](docs/architecture.md).

## Conventions

- **Coordinates are `[lng, lat]`** everywhere in this app—storage, payloads, GeoJSON, exports.
- **A button is a highway guide sign by default.** Ziad's call, 2026-08-22: `.btn` carries the green field, the inset white keyline and an arrow at the right pointing east, with no extra class. `.btn-sign` still works and means the same thing—it is an alias kept because it reads as intent. `.arrow-left` puts the arrow back on the left pointing west, and the eight `.arrow-*` bearings override the direction. **Opting out is a named list, `$btn-flat` in `style/_chrome.scss`**, and a new variant gets the sign until it is added there. That is the intended failure: a button that inherits the house style by accident is better than one that quietly leaves it.
- **Formatting is prettier**, configured in `.prettierrc`. Do not argue with it; note that `public/js/**` and SCSS have deliberate per-glob overrides.
- **Prose is never hard-wrapped.** One line per paragraph, soft-wrapped by the editor. Em dashes are tight (`word—word`); use a spaced en dash when a line wants air. The pre-commit hook fixes and re-stages.
- **Widows are a CSS problem first.** `text-wrap: pretty` is set on body copy in `style/_base.scss` and covers every page a browser renders, so page copy needs nothing hand-placed. Two surfaces are outside it and bind their own last two words with `&nbsp;`: `src/emails/`, because no mail client supports the property, and the printed roadbook. In static JSX write the entity straight into the markup—esbuild decodes it to U+00A0 while transpiling. For a string shared between an email's HTML and text arms, use `noWidow()` from `src/views/widow.ts`, so only the HTML arm carries the character; a text/plain part must not.
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
- **`points.uid` is the point's identity; `points.id` is not.** The builder's `PUT` deletes and re-inserts every day and point on every save, so ids churn constantly—that was accepted deliberately on 2026-08-15 and has not changed. Anything that must reference a point across a save uses `uid`, which the CLIENT mints (`uid()` in `public/js/builder.js`, mirroring `newUid()` in `src/maps/uid.ts`—same alphabet and length, or the save 400s). **There are two places points are inserted and both must supply a uid:** `insertRideGraph` and the lossy import in `src/routes/maps.ts`. A missing one fails the NOT NULL at runtime with nothing useful to say.
- **`point_details` cascades from `rides`, not from `days`.** That is what makes a stop's confirmation number survive the `delete(days)` at the top of every save. The flip side: nothing else cleans it up, so `writePointDetails` in `ride-graph.ts` deletes rows whose uid left the payload. Skip that and a deleted stop's gate code lives forever.
- **`null` is not zero.** Twistiness `null` means nothing measured it; `0` means the road is straight. Same for `dist_from_start_m` on a trackless import. A format that guesses is indistinguishable from one that knows.
- **`rides.size_bytes` must name every byte column.** The app increments `users.used_bytes` on import and the database decrements it from `size_bytes` on delete, so a column missing from that generated expression leaks quota on every delete, silently and permanently.
- **`.tb-marker` is deliberately `0×0`** in `style/_map.scss`. An `AdvancedMarkerElement` anchors its content at bottom-center, so a zero-size wrapper puts the anchor on the point and the negative-margin offsets keep working. Give it a size and every marker drifts.
- **A day is drawn as one polyline**, the concatenated geometry of all its legs, with the duplicate vertex dropped at each joint and no indices consumed by an empty leg. Turning a drag index back into a leg plus a via-point slot is the entire job of `public/js/route-shape.js`. Do not switch to one polyline per leg—the layer-id contract every caller depends on assumes otherwise.
- **The zip download route is registered ahead of the generic `:format` route on purpose** in `src/index.tsx`. Registered after it, the generic route swallows `/zip/gpx` and answers with a plain GPX. Observed, not theorized.
- **The `routeloop_` filename marker is load-bearing.** `parseExportName` returns `null` without it, so a rider's own `day-2.gpx` is never reinterpreted. Underscores separate fields and hyphens live inside one; do not simplify the separator. Dates are formatted and parsed in UTC because the roadbook renders `days.start_at` with `timeZone: 'UTC'`.
- **Two brand names are read where one is written, and that is permanent.** `READ_MARKERS` in `src/maps/filename.ts` accepts `tankbag_` alongside `routeloop_`, `COMPOUND_EXTS` accepts `.tankbag.json`, `nativeVersion()` in `src/maps/export.ts` reads either version key, and `/api/public/maps/:slug/tankbag.json` is still routed. None of that is leftover debris from the rename—it is what keeps every file a rider already downloaded importable, and dropping it fails silently: the files still import, just stripped of the day order and dates that GPX and KML cannot carry internally. `public/js/filename.js` mirrors all of it. Tidying any of it away needs a decision, not a cleanup pass.
- **A filename is not a format.** It carries four fields and the date is the one doing the work, because GPX and KML cannot hold a schedule. Resist adding roles, colors or dwell to it.
- **The pre-commit tightener rewrites em dashes in test fixtures too.** `test/em-dashes.test.ts` was once committed comparing strings to themselves because of it.
- **There is no global `border-box` reset in `style/`.** Every fixed-size box sets its own `box-sizing`, so a new one that forgets has its `width` and `aspect-ratio` describe the CONTENT box while padding sits outside them—it renders wider than it declares and nothing warns. It cost a day on `.btn-stop`, where the symptom was a legend that would not wrap at any viewport.
- **Never put a raw U+00A0 in source.** It is invisible in a diff and in most editors, so a stray one is unreviewable and a stripped one is undetectable. Write `&nbsp;` in JSX text, `'\u00a0'` in a string literal. Note also that the em-dash tightener counts a non-breaking space as whitespace on both sides of a dash, so binding a pair across an em dash is silently undone by the pre-commit hook.
- **A broad `npx prettier --write "src/**/*.ts"` produces about 22 files of collateral.** The committed tree is not prettier-clean under the current config, so a wide glob reformats files you never touched—line wraps collapsed, arrow-body parens added—and sweeps them into your commit. Scope the glob to the files you actually changed.
- **Never interpolate a JS array into a tagged `sql` template.** Drizzle expands the array into a tuple, so a hand-written `= any(...)` over one comes out as `any(($2, $3, $4))`, which is not valid SQL. Use `inArray`. There is no type error and no test failure—it fails at runtime, on the first render of whatever page needed it.
- **An email may not put `#` before a number.** `test/email-theme.test.ts` scans rendered HTML for `#` followed by 3–6 hex characters to catch a template inventing a color, and every decimal digit is also a hex digit, so "Report #1042" fails the guard. The scanner cannot be narrowed to attribute values either: `shell.tsx` puts most colors in `<style>` blocks. Write "Report 1042".
- **`test/emails.test.ts` requires every link in a template's HTML arm to appear in its text arm.** A text-only client silently losing a link is the failure the two-arm contract exists to prevent.
- **Feedback attachment bytes are counted in `feedback_attachments.bytes` and nowhere else.** They must stay out of `rides.size_bytes` and `users.used_bytes`—an attachment is not ride data, must not eat a rider's quota, and a fourth byte column in that generated expression would corrupt quota accounting on every ride delete.
- **The queue's moderation handler writes only the fields it is given.** That is why it is several small forms rather than one wide one: a single form carrying every field would blank whatever the owner had not retyped. Keep `moderate()` field-optional if you touch it.
- **`utils/` is not in `tsconfig.json`.** `npm run typecheck` does not cover it, and a bad import there fails only at runtime. Check a `utils/` change by hand:

  ```bash
  npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler \
    --types node --esModuleInterop --skipLibCheck utils/seed-demo-rides.ts
  ```

- **`test/` is in `tsconfig.json` on purpose.** Vitest transpiles without type-checking, so removing it hides fixture drift. Keep it there.
- **The builder's snapshot shares what is never mutated in place, and that set changes.** `leg.geometry` is shared by reference because it is always replaced wholesale; `point.roles` must be copied because `splice()` mutates it, and `point.details` joins it for the same reason—the field editor assigns into that object one field at a time, and `details.links` is an array it pushes to. `leg.viaPoints` moved between the two groups the day drag-to-shape shipped and nothing failed loudly. Re-check whenever you add an edit-in-place feature.
- **SortableJS `filter` cancels the click that focuses an input, and `preventOnFilter: false` is what stops it.** The option defaults to TRUE, so Sortable calls `preventDefault()` on any pointerdown landing inside a filtered element—and the default action being canceled is the one that moves focus. Each day's `.add-row` is filtered so a drag cannot start on it, which silently made its search field unclickable: it could be tabbed to and typed in, but a click left focus on `<body>`. Shipped that way and reported as "I can't click into the search"; fixed 2026-08-22. `filter` still blocks the drag either way—that check does not need the event canceled.
- **Empty days are dropped at save time.** The API requires at least one stop per day, so `payload()` in `builder.js` filters days with no points rather than failing the whole ride. The stop is guaranteed by `addPoint()` promoting the first point of every day; the schema still refuses a day of nothing but POIs, and the refine says so.
- **`ride.json` still sends `stops` and `pois` as two arrays, and that is deliberate.** The builder payload and the native JSON became one ordered `points` list on 2026-08-23; the viewer contract did not, because the viewer draws markers and a timeline and never renders points as a sequence. `ride-time.js` and `twist.js` are shared by both surfaces and accept EITHER shape—`stopsOf`/`poisOf` at the top of each is the only place that difference is known. Break that and the builder and the viewer disagree about a ride's schedule.
- **Native JSON is format version 4, and versions 2 and 3 still import.** `upgradeNativeRide` merges an older file's `stops` and `pois` into one list, stops first, stamping each kind explicitly—a v3 stop must not fall through to the `poi` default. Riders have those files on disk and a backup that will not restore is not a backup.
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
