# Status and handoff

**Updated:** 2026-08-26
**Branch:** `feat/import-review-and-export-cart`, committed. **1,935 tests across 72 files** (2 skipped, 1,937 total)
**Closes, when it merges:** [#129](https://github.com/feralcreative/routeloop/issues/129), [#131](https://github.com/feralcreative/routeloop/issues/131), [#35](https://github.com/feralcreative/routeloop/issues/35) and [#13](https://github.com/feralcreative/routeloop/issues/13)—which clears `area:import-export` entirely. [#130](https://github.com/feralcreative/routeloop/issues/130), the content-width prerequisite, was already closed.
**Closes, when it merges:** [#67](https://github.com/feralcreative/routeloop/issues/67) and [#52](https://github.com/feralcreative/routeloop/issues/52). Merged before it, in order: the recycle bin as [#149](https://github.com/feralcreative/routeloop/pull/149), the Paddock as [#151](https://github.com/feralcreative/routeloop/pull/151), the rider and access layer as [#152](https://github.com/feralcreative/routeloop/pull/152), and membership and voting as [#153](https://github.com/feralcreative/routeloop/pull/153).
**For:** the next agent, or the owner returning cold

## The import review table and the export cart—2026-08-26

`/import` is both halves rewritten. **The import half stages in the browser**: `planImport()` still guesses the ride name, day order, dates and per-day names off the filenames, but the preview is now an editable table—drag or arrow the rows, retype a name or a date, drop a row—and the corrections post beside the files as a `manifest`. There is no stage id, no temp directory and no expiry sweep, which was the deliberate choice: the page holds the files until Import is pressed. Two consequences are by design rather than unfinished—**a zip cannot be reviewed** (nothing unzips in the browser), and **a dropped row never uploads**, because the page rebuilds its own file input through a `DataTransfer` first.

**No manifest means the old behavior exactly.** That is what keeps the plain form working with JavaScript off and leaves every API client alone, and it is worth not breaking: `src/maps/manifest.ts` is a deliberate hole in the invariant `filename.ts` states, and the absent case is the one that still honors it.

**The export half is a search box, a cart and one zip.** It used to select every ride the owner had, unpaginated, and render one row per ride times one button per format. `/api/export/search` is capped at 12 and searches names **and the days' dates**—not `rides.created_at`, because a rider searching "August" means when they rode. `POST /export/zip` takes at most 20 rides, re-checks ownership per slug, and names the archive for the export rather than for any ride in it.

**Two traps this branch walked into, both now written down in AGENTS.md.** `GET /api/rides/:id` silently swallows any `/api/rides/<word>` added later—the search endpoint answered `{"error":"not found"}` as a lookup for a ride called "search"—hence `/api/export/search`. And a typed day name has to outrank the file's own `<trk><name>`, or a correction does nothing at all; the first pass had the precedence backwards and the ride imported with the GPX's name.

## The fidelity matrix—2026-08-27

`test/fidelity.test.ts` is the second half of #35—the first half, format agreement, has been in `round-trip.test.ts` since August 4. It declares per field per format what survives, in two columns that disagree on purpose: `writes` is what a third-party tool opening the file sees, `reads` is what our importer gets back. Per-day color is written by KML and GeoJSON and read back by neither.

**One thing it turned up and one decision it settled.** No lossy format writes a day's start or end time, GeoJSON included although it could—left that way on purpose so the four agree and the filename stays the one place a date travels; recorded in docs/decisions.md. And #13's five boxes were all already satisfied in code—native JSON both ways, KMZ and CSV import, GeoJSON both ways, GPX as `trkpt` shaping points rather than `rtept`, everything inside the XXE-safe quota-enforced pipeline—so it closes with this branch as finished rather than as built here.

## Switching machines—read this first

Rewritten 2026-08-26. The version this replaced still described `fix/map-mechanics` and `drizzle/0009`, both months gone.

**Everything in the repo travels with `git pull`.** What does not is below, and it is the whole list.

### 1. The database

**Measured 2026-08-27, because this paragraph was wrong for weeks.** It read *"stage and production have seen none of them"*, and production had in fact recorded nineteen. Do not trust a written claim about which migrations an environment has—ask it:

```bash
DEPLOY_ENV=prod utils/deploy/deploy-utils.sh schema-state
```

- **Production is current and healthy:** 26 tables, 19 migrations recorded, 6 users and 10 rides. Nothing outstanding.
- **Stage was a STALE ADOPTED VOLUME**, not a database that was merely behind: 7 tables including `routes`—the name replaced by `days` on 2026-08-09—with 0 migrations recorded and **0 rows in every table**. Its schemas were dropped on 2026-08-27 and it rebuilds from `0000` on the next deploy. **Baselining it would have been the damaging move**, recording all 19 as applied against a schema missing most of them; that is why `schema-state` exists and why the deploy's failure message now tells you to look before choosing a fix.

`npm run dev` applies whatever is outstanding through `predev`, so a second development machine catches up by itself the first time it starts the server—but take a `db-backup` before pointing anything at a database you care about.

Four of those carry more than a schema change, and none of the four is repeatable by re-running the migration:

| Migration | The part a differ could not write |
| --- | --- |
| `0012` | A hand-added `UPDATE` raising the quota only for rows still on the OLD default. Without it the `SET DEFAULT` reaches new rows alone. |
| `0015` | `INSERT ... SELECT` putting every existing ride's owner on its own roster, and a three-statement backfill for `days.uid` (the differ emitted a bare `NOT NULL`, which fails on a populated table). |
| `0016`, `0017` | Fully additive, no backfill. Read them anyway for the six `set null` foreign keys, which are the deliberate half. |

**Two data migrations are scripts, not SQL, and neither has run anywhere.** Nothing rejects a row that still needs them, which is why they are here rather than in a changelog:

- `utils/split-imported-legs.ts`—days stored before 2026-08-24 carry `stops - 1` legs where a day now needs `points - 1`. Opening one in the builder fills the gap with straight placeholder legs on the first edit, silently. `--dry-run` first.
- `utils/shift-days-to-wall-clock.ts --zone <IANA>`—days whose `start_at` still holds an instant rather than a wall clock. **NOT idempotent**: a shifted row is indistinguishable from an unshifted one, so it runs once, after a backup.

### 2. Things that are not in the repo at all

- **A GCP key change.** `GMAPS_SERVER_KEY` (project `976935115789`) had **Places API (New)** added to its API restriction list on 2026-08-24, because category search 403s without it. If production uses a different key, category search will 503 there with a message naming the fix. The IP restriction is unchanged and must stay.
- **`.env`.** `.env.example` is the annotated list of every key; copy and fill. `PURGE_ACCOUNTS` is off by default and destructive—leave it off on a development machine.
- **`storage/`.** Gitignored. A fresh clone falls back to `test/fixtures/coast-run.kml` for the seed, which works but gives a 4-point sample rather than the 26-point one.
- **`gcloud config`** defaults to a Visa work project on the primary machine. Every `gcloud` call touching this app must pass `--project=976935115789` explicitly.

### 3. First run on a new machine

```bash
fnm use                       # or nvm — .node-version pins Node 24
npm install
docker compose up -d --wait db
npm run dev                   # predev applies every outstanding migration
```

Then `git config core.hooksPath .githooks` once per clone, or the em-dash tightener does not run on commit.


## Rider subgroups—read before touching days, the roadbook, or the exports

Eight commits on `feat/rider-subgroups`, nothing pushed. `drizzle/0016` and `0017` have run on **this machine only**; both are fully additive and neither needs a backfill.

All nine of #67's boxes, plus #52 which was waiting on the Paddock and the roster both.

- **A FEEDER IS A DAY.** `days.subgroup_id`, nullable, null meaning everyone rides it. A subgroup owns a SUBSEQUENCE of the ride's dense positions, so `uq_day_ride_pos` never changed and a multi-day approach is simply more days. The rejected model—subgroups on legs—breaks the settled rule that a day is one ordered list of points. `docs/decisions.md` has the whole argument; do not reopen it without reading that.
- **Meets and splits are DERIVED, never stored.** `junctions()` walks the day list. The `meet`/`split` waypoint roles stay labels and nothing reads them structurally.
- **Whose clock and which event are two separate axes**, `rides.primary_subgroup_id` and `rides.time_anchor`, which is what dissolves the contradiction #143 was written with.
- **Every per-rider surface takes `?group`**: the roadbook, the hand-off, all four formats and the zip. Derived from membership, `?group=all` for the whole ride. `ride.json` deliberately does the opposite and tags rather than filters, because the viewer draws the whole shape and dims what you are not on.
- **The rendezvous proposer calls no router.** Pure geometry, four scoring terms, two hard refusals and a shared-road floor. It can return nothing, which is a real answer.
- **#52**: fuel planned around the smallest tank coming, `ride_members.bike_id` falling back to a rider's default.

### What was verified, and how

**THIS IS THE FIRST BRANCH WITH A REAL BROWSER PASS**, and it found a bug nothing else could have. A rewrite of `takeMeet()` by index range silently deleted `removeSubgroup`, `findMeet` and `meetResultHtml`—Delete threw `ReferenceError` and Find a meet did nothing. `public/js` is neither typechecked nor covered by Vitest, so typecheck and 1,728 tests were both green. Do a browser pass on client work.

Checked in Chrome: the Groups block renders, add/rename/recolor/delete all work, deleting a group that owns a day un-tags the day rather than destroying it, the day pickers stay in step with a rename, the fairness note appears when the primary is not the group with farthest to ride, Find a meet reports its refusals in words, the viewer dims the other approach and full-strengths your own, and the roster renders the fuel line and both selects. Console clean on all of it.

Checked over HTTP: subgroup ids survive a re-save and so do rider assignments; the roadbook and hand-off filter per strand and `?group=all` returns the whole ride; `timeAnchor` round-trips (it silently did not, and the round-trip test is what caught it); assigning a rider to another ride's subgroup is refused.

**Not verified:** the printed roadbook, and the `<noscript>` fallbacks on the three submit-on-change selects.

### Still outstanding

- **An export filename does not name the subgroup.** Two riders downloading the same day get files with the same name and different contents. `AGENTS.md` says a filename carries four fields and to resist adding more, so this was left alone deliberately rather than fixed—it needs a decision.
- **Nobody is told anything.** No mail on being added to a ride, on a friend request, or on a vote closing. Three branches have now added a thing a rider finds out by looking.
- **Timing is solved but not SHOWN.** `solveStrands` is written and tested; no surface calls it yet. The roadbook is the obvious place and it is the one piece of #67 that is built and invisible.


## Membership and voting (merged as #153)—read before touching days or alternates

Merged. `drizzle/0015` has still run on **this machine only**, and it carries a DATA migration as well as a schema one.

- **`days.uid` is new, and it is the reason this branch exists.** A vote could not reference a day: `days.id` churns because the builder's `PUT` deletes and re-inserts every day on every save, and `alt_group` is renumbered densely each time. Same answer `points.uid` was to the same problem, minted by the client, carried through the payload and the native JSON.
- **The migration was hand-edited twice.** The differ emitted the uid column as a bare `NOT NULL` with no default, which fails on a populated table; it is three statements now. And it carries an `INSERT ... SELECT` putting every existing ride's owner on its own roster, which no differ could know about.
- **Membership ships working, and the invite path is a FRIEND and nothing else.** No token, no email, no account creation—which is what dissolved the sign-off the last branch could not get. `ride_invites` stays unbuilt rather than deferred.
- **`/m/:slug/riders` is the roster**, gated on membership rather than visibility, and it replaced the inert stub in the builder panel. A rider who is not the owner has no builder to open and still has to RSVP and vote.
- **Voting is one pick per member per alternate group**, enforced in the transaction because a group has no durable id to index. A tie elects nobody. A deadline is opt-in per ride, and clearing it on resolve is what makes the sweep idempotent.
- **`startVoteResolver()` is a new sweep** in `src/index.tsx`, alongside the trash purge and the quota sweep. A ride with no deadline is never selected, which is every ride until an owner sets one.

### What was verified by hand, and what was not

Same as last branch: there is no database-backed suite, so the paths that need one were checked against the local database directly.

- A uid survives a full-replace `PUT` unchanged, and a save that drops a day reconciles that day's votes away.
- The membership grant opens a private ride to a member and refuses a stranger.
- Invite, re-invite, RSVP, a bogus RSVP, and the owner trying to remove themselves—all through HTTP with the right refusals.
- Vote, withdraw by pressing again, a 1–1 tie changing nothing, a 2–0 electing a winner without tripping `uq_day_alt_active`, voting refused while closed, and the sweep clearing the deadline and being a no-op on a second pass.

**Not verified:** anything in a real browser. The roster page, the ballot and the RSVP select have had no browser pass, and the RSVP select submits on `change` with a `<noscript>` Save button that has not been exercised.

### Still outstanding from this work

- **Nobody is told they were added to a ride.** They find out by looking at their dashboard. `src/auth/notify.ts` is the precedent for where a mail would live, and the same gap exists for friend requests from the last branch.
- **The roster is not in the account archive.** `src/account/export.ts` covers rides and profile; who a rider rides with is arguably theirs too.
- **#52 group-aware range planning is now unblocked**—both halves exist, `bikes` from the Paddock and `ride_members` from this. It is an `area:builder` issue.
- **#67 is next and its model is settled**: a feeder is a day tagged with a subgroup, `days.subgroup_id` nullable. Written up in `docs/decisions.md` with the two consequences to plan for—the builder's day list stops being a straight sequence, and `MAX_DAYS` counts feeder days.


## The rider and access layer (merged as #152)—read before touching visibility

Merged. `drizzle/0014` has still run on **this machine only**—stage and production have seen none of it.

- **`src/access/policy.ts` is now the only place the visibility table is written down.** Three hand-rolled copies of the same four-clause gate—`getViewable` in `index.tsx`, and one each in `handoff.tsx` and `roadbook.tsx`—collapsed into `viewableRide()` in `src/access/query.ts`. Every route that serves a ride by slug goes through it.
- **Two behaviors folded in that only the `index.tsx` copy had:** the roadbook and the hand-off page now go dark for a leaving owner and for a trashed ride. That is what they should always have done; both pages ARE the ride, rendered differently.
- **`visibility` has a fourth member, `friends`,** and it is on: the builder select, the import form and the API all take it. `public` and `unlisted` kept their exact meanings; `private` gained "and members", over a table with no rows.
- **Friendships ship working.** `/friends`, plus buttons on `/riders` and on a public profile. One row per pair under `rider_a < rider_b`. A block removes both halves of the pair from the roster, symmetrically.
- **`ride_members` ships as SCHEMA ONLY.** Ziad's call: the invite path is cut, so nothing inserts a row. `canView()` already honors the grant, and the controls that would use it are inert markup in the builder panel (`.roster-stub`). Do not wire them up as a cleanup.
- **`test/viz-categories.test.ts` is new**—the data-viz validator `style/_dashboard.scss` claimed to have and the repo did not contain. It measures the four categorical slots across all six palettes and **records a real failure it did not introduce**: `$disabled` and `$interstate` collapse to ΔE 2.05 under tritanopia.

### What was verified by hand, and what was not

There is no database-backed suite, so the grant paths were checked against the local database directly rather than in Vitest:

- Every combination of the four levels against anonymous, owner, friend and stranger, plus the membership grant, both through `viewableRide()` directly and over HTTP on `/m/:slug`, the roadbook, the hand-off page and `ride.json`.
- All five friendship verbs end to end, including that a block empties the roster and that an accepted friendship opens a `friends` ride and its clone.
- `/explore` does not list a `friends` ride.

**Not verified:** anything in a real browser. The builder's visibility select, the roster stub's rendering and the friends page on a phone have had no browser pass.

### Still outstanding from this work

- **Nothing writes a friend request to email.** A rider learns about one by visiting `/friends`. `src/auth/notify.ts` is the precedent for where such a thing would live.
- **The account archive does not include friendships.** `src/account/export.ts` covers rides and profile; a friends list is rider data and arguably belongs there.
- **The release-notes entry for this work carries no build stamp.** `src/content/release-notes.html` wants the exact string the deploy prints (`2026-08-26-HHMMPT`) in the `<code>`, and that is not knowable before the deploy runs. Fill it in then. The recycle bin and the Paddock have no entry at all yet.
- **A friends-only ride is one extra indexed lookup per view.** `grantsFor()` short-circuits for public, unlisted, the owner and anonymous visitors, so the common path costs nothing—but the query is not cached.

**#67 is still unwritten.** The rewrite described in the next section was scheduled as the first task of 2026-08-26 and did not happen; the Paddock and this branch went first. It is still owed, and #71 is now built enough for it—`ride_members` exists.


## Open

Pruned 2026-08-26. Everything below is believed true today; anything that had been overtaken by later work was deleted rather than left to be reconciled. The migration inventory that used to live here is in **Switching machines** above, which is now the single place that says what has and has not run.

**THREE RIDERS ARE ON PRODUCTION, AND THAT CHANGES THE DEPLOY CALCULUS.** Ziad let them in on or before 2026-08-25. The database was always precious; the uptime is what changed.

**PHASE 1 OF THE ZERO-DOWNTIME PLAN IS BUILT AND UNSHIPPED.** [docs/zero-downtime-deploy.md](zero-downtime-deploy.md), written 2026-08-25, built 2026-08-27 on `feat/zero-downtime-phase-1`. The deploy no longer tears the database down, migrations run in a one-shot `migrate` container before the new code serves anything, and the verify polls `/healthz` and asserts the SHA it just pushed instead of `sleep 5` plus a non-fatal curl of `/`. Roughly 60–90s of 502s becomes 10–20s.

**It has not been deployed anywhere, and one thing in it cannot be verified from a laptop.** The `Dockerfile` now ends `CMD ["node", "--import", "tsx", "src/index.tsx"]` so that Node is PID 1 and can receive SIGTERM. `node --import tsx` is verified against the pinned `tsx ^4.19.2`, and the drain itself is verified locally—265ms, both log lines, clean exit. Whether the SIGNAL reaches PID 1 **inside the container** is not, and it is the kind of failure that is completely silent. **The acceptance test on stage:** `docker stop <container>`, then confirm both that `[shutdown] SIGTERM received, draining` appears in `docker logs` AND that the container exits in about a second rather than taking the full ten-second SIGKILL timeout.

**Phase 2—blue/green behind Caddy—is still a proposal and nothing in it is built.** Three of the plan's six open calls are answered; the three that remain are all Phase 2's, and it still names approvals that have not been given: Caddy as a new production dependency, anything touching prod or stage, and a migration-authoring rule that is effectively a schema-policy change. **Do not start building it without those answers.**

One thing that plan turned up which stays true whatever happens to Phase 2:

1. **Every migration in `drizzle/` is additive.** Eighteen files, not one `DROP` and not one `RENAME`. Three tighten a column to `NOT NULL` (`0006` on `points.uid`, `0008` on `points.position`, `0015` on `days.uid`) and each is hand-rewritten with a backfill in front of it. So the expand/contract rule Phase 2 would impose costs close to nothing in practice.

**OWED BROWSER PASSES, and this is now a rule rather than a note.** Nothing automated covers the map, the builder or the viewer, and `public/js` is neither typechecked nor reachable by Vitest. The subgroups branch was the first to get a real browser pass and it found a bug that typecheck and 1,728 tests both missed—three functions silently deleted by a rewrite. **Drive client work by hand before calling it done.** Still unexercised: the printed roadbook, and the `<noscript>` fallbacks on the submit-on-change selects in the roster.

**Nobody is told anything.** Three consecutive branches have shipped a thing a rider only discovers by looking at a page: a friend request, being added to a ride, and a vote closing. `src/auth/notify.ts` and `src/feedback/notify.ts` are the precedent for where such a thing lives—outside `src/emails/`, which is pure and must stay that way.

**`solveStrands` is built, tested and called by nothing.** The cross-subgroup timing solve in `src/subgroups/schedule.ts` works and is the one piece of #67 that is finished and invisible. The roadbook is the obvious surface.

**An export filename does not name the subgroup.** Two riders downloading the same day of the same ride get files with the same name and different contents. `AGENTS.md` says a filename carries four fields and to resist adding more, so this was left alone deliberately—it needs a decision, not a patch.

**Still hardcoded `en-US`:** number grouping in `src/stats/shape.ts` (`fmtMiles`, `fmtCount`) and the dashboard's month label. Left alone on purpose—all three date-format members are English and produce identical output, so threading a format through ten call sites would change nothing visible. It starts mattering the day a `de-DE`-style member is added.

**`_PLANS/` is gitignored and its contents do not travel.** Each branch this month wrote a scope document there. They are working notes, not a record; anything worth keeping was moved into `docs/decisions.md` at the end of each branch.

**The working rules, both Ziad's call 2026-08-24 and both still in force.** An audible gets its issue written AFTER the fact and closed immediately—the tracker is what answers "why is it like this" a year from now. And branch by AREA rather than by issue: pick one, clear what you can, one PR, move on. Group liberally; a hyper-granular history of one-issue branches is explicitly not wanted.

Read [AGENTS.md](../AGENTS.md) for the operating rules, then this for where things actually stand. This document goes stale fastest; if it disagrees with the code, the code is right.

## The dashboard branch and the theme engine (merged)—2026-08-24/25

**`feat/dashboard-and-themes`, merged.** Clearing `area:dashboard` under the branch-by-area rule. Four of the six issues are done; [#102](https://github.com/feralcreative/routeloop/issues/102) is half done and is the reason the branch is still open.

### Four calls settled on #103, all Ziad's

| Call | Decision |
| --- | --- |
| `used_bytes` drift | **Recompute it on a timer.** The tally repairs itself instead of drifting forever |
| Empty state | A real first-run panel—**not built yet**, see below |
| `/rides` vs the dashboard | **Fold `/rides` into `/`.** One door onto a rider's own rides |
| Ride time | **Estimate the missing duration** from distance, so the total covers imports |

### What landed

- **`/rides` folded into `/`** (`d79b9d1`). `rides.tsx` is now a 302 and nothing else; `OwnRideRow` moved to `home.tsx` with its visibility pill and edit link intact. The list is capped at 24 with `?rides=all` lifting it to a ceiling of 500—the page it absorbed was unpaginated. `NavKey` lost `'rides'` entirely, because a key no item carries is a dead `aria-current` state, which is the exact bug `'home'` sat in for months. `/dashboard` now points straight at `/` rather than chaining.
- **Saddle time, reported honestly** (`be7c823`). `src/maps/ride-time.ts` mirrors the client's estimation rule and `test/ride-time-server.test.ts` pins the two together; `query.ts` BINDS `NOMINAL_SPEED_MS` into the SQL rather than writing `20` into the string. `SaddleTime.estimated` is how the hero admits part of the figure was figured rather than measured.
- **The quota reconciler** (`be7c823`), `src/account/quota-sweep.ts`, one `UPDATE … FROM` on the thumbnail sweep's five-minute cadence. Driven against the local database rather than reasoned about: drifted one rider high and one low, it repaired exactly those two and reported 0 on a second pass.
- **The comparison columns** (`576b441`). **The probe caught a real defect here and it is worth knowing about**: grouping each metric by `owner_id` independently looks equivalent to one shared cohort and is not. Marking a single day a losing alternate moved the days average from 13 to **19—upward**, because the rider it belonged to fell out of that metric's denominator instead of counting as the zero they had. Four metrics on four denominators cannot be compared across a row of tiles. The cohort is defined once now and each metric LEFT JOINs onto it.
- **Every inline color derivation promoted to a named token** (`a00b5c1`, first half). 49 `color.adjust()` calls across 11 stylesheets became 29 tokens, and **the compiled CSS came out byte-identical at 100,198 bytes**—Ziad's call, choosing a provable refactor over a tidier one.
- **The theme engine** (`a00b5c1`). Six palettes on two independent axes, emitted as custom properties across nine blocks. Every token is a `var(--x)` reference, which is what let ~950 existing references switch without being edited.
- **The preference, end to end** (`86d54d1`). `drizzle/0010` adds `user_profiles.theme` and `.scheme`, purely additive with defaults. The palette rides on the SESSION query—`validateSessionToken` already joins, so it costs no extra round trip—and `page()` reads it off `user`, which is what reaches all 32 call sites without touching one.

### Three traps this branch set, all silent

1. **`rgba($token, 0.06)` compiles to `rgba(var(--x), 0.06)`, which is invalid CSS and drops the declaration.** Seventeen tints were broken this way and the build succeeded throughout. All are `color-mix(in srgb, $token N%, transparent)` now. The rule is written into `_tokens.scss`: **if Sass has to compute it, it needs a real color.**
2. **`$ink-dark` must not follow the scheme.** It is the legend on a black-legend sign field, and sign fields are scheme-invariant—a yellow signal head takes black ink at night too. Inverting it put white on yellow at 1.4:1. The two legends are literals in all six palettes; `$white`/`$black` as page SURFACES do flip.
3. **`.feedback-flow` was only pretending to be pinned.** It aliased `$white` and `$neutral-21`, which read as pinned and were not—the moment tokens became `var()` it would have gone dark in direct sunlight with nothing in that file changing. It reads `palette.light()` now.

**A note on searching for these:** the tint bug survived two searches because `"rgba(\$"` in double quotes reaches grep as `rgba($`, where `$` is an end-of-line anchor. Use `grep -E` with a single-quoted pattern when hunting build-time color functions.

### What is owed before #102 can close

- **Six contrast audits, MEASURED.** The high-contrast and colorblind hex values in `_palette.scss` are reasoned, not measured, and the file says so. +20% on a dark ground and −20% on a light one land on different ratios, so the five non-default palettes cannot be inferred from the light one.
- **The second-cue audit.** A theme that only shifts hues does not fix a signal carrying meaning alone. **The colorblind theme is a claim the app does not yet honor**, and the palette comment says so outright. Do not offer it to a rider before this is done.
- Two data URIs hardcode hex (`%23fff` in `_chrome.scss`, `%23777777` in `_builder.scss`) and cannot theme—a data URI cannot carry a custom property. Known, not yet decided.

### Phase 4, and what the contrast audit found—2026-08-25

**Everything above was the branch as of the morning. The rest of it is built.** #135, #136, #139 and the first-run panel are done, and #102's two owed audits are done and enforced. Uncommitted.

**#139, the role chart.** `src/maps/role-colors.ts` is seventeen hues at ONE fixed lightness and ONE fixed chroma, generated by `utils/build-role-colors.mjs` rather than picked. Equal lightness is what makes it categorical—seventeen roles have no rank, and a ring whose members differ in lightness implies one. The hues are walked with a **stride of 7, coprime with 17**, so consecutive roles land ~148° apart and two roles adjacent in the chart are never adjacent in hue. `RoleChart` inlines each mark through `icon()`; an `<img>` would have painted a black disc, because `currentColor` inside an externally-referenced SVG resolves against that file's context. **One ring serves both schemes**, Ziad's call: every entry clears 3:1 against the light page, the dark page and the white glyph, and those pull against each other. It does NOT follow the colorblind theme, deliberately—seventeen categories cannot be told apart by hue under dichromacy at all, so the icon and the label carry identity and the color is redundant with both.

**#136, the records.** The numeral is set large and the unit split off it, so "482 mi" stops spending its emphasis on "mi"; each card takes an accent edge, a mark and a hover lift; the figures count up on load, gated on `prefers-reduced-motion` and landing on the string the server already rendered. `RecordTile` replaced the shared `Tile` type—a record's `value` is now the number alone, and `numeric` picks the type size because two of the four records are words. **The four marks are PLACEHOLDERS**, simple geometry in the house shape, standing in until Ziad draws them; replacing `public/img/icons/icon-record-*.svg` is the whole job.

**#135, cards everywhere.** `.ride-cards` is a new class and `ul.cards` is untouched—that one is the generic white-row list `/admin`'s roster and the survey summary are built on, and repurposing it would have given the roster a column of empty frames. One card, two densities: `/explore` and a public profile are pages whose whole job is the list, and the dashboard's own list takes `--dense` and packs five across. `CardFace` is shared between the public card and the owner's; the pill and the Edit link sit OUTSIDE the anchor, because an `<a>` inside an `<a>` closes the outer one early and drops half the card out of the link. `a.card`, `.swatch` and `.cardrow` are gone.

**The first-run panel (#103).** Three steps and two doors rather than one line and two links. On a first visit this is not an empty section—it is the entire page, so it says what the app is for.

### The audit found four defects, and that is the point of it

**`test/palette-contrast.test.ts` compiles the SCSS and asserts every pair the app actually paints, in all six palettes.** Not a report—an enforcement. The thing that made the audit owed is that nothing failed when a value was wrong, which is the same reason seventeen tints shipped broken earlier on this branch. It found:

1. **High contrast darkened two black-legend fields.** `$detour` and `$go` came out at **3.31:1** and **3.88:1** where the DEFAULT theme has them at 6.59 and 7.39—the theme named for legibility was the least legible of the three on those two. The rule written in the file was right and the arithmetic went the other way.
2. **The colorblind palette broke the ink pairing.** The Okabe-Ito vermillion and blue separate on blue-yellow exactly as intended and land on the wrong side of the legend table: white ink on the vermillion measured 3.87:1 and black ink on the blue 4.05:1. Fixed by moving the colors, not the table—`$ink-light`/`$ink-dark` are referenced directly by dozens of rules, so a legend that changed with the theme means every button variant has to know which theme is active.
3. **Links were illegible on every dark palette**: **2.52:1** default, **1.71:1** high contrast, 2.30:1 colorblind. `$url` was an alias of `$disabled`, and those agree on a white page and are opposites on a near-black one—one is a sign FIELD carrying a white legend, the other is TEXT on the page. `$url` now lifts 30% on the dark scheme; `$disabled` does not move, because a sign field is scheme-invariant.
4. **`$pending` and `$label` were 2.24:1 and 2.44:1 on high contrast.** A relative step off a field that the theme had lightened. They take an absolute lightness now (`-tone()`), which leaves the default palette **byte-identical** and puts high contrast at 4.71:1.

Two more things the audit surfaced on the way: `color.adjust()` does not clamp at zero, so the colorblind dark palette was emitting `hsl(…, -3.04%)` for `--gpx-l45` and a browser was silently painting it black; and `contrast()` could not read `rgb(60%, …)`, which is how Sass writes anything `color.adjust()` produced—so the two tokens most likely to have a contrast problem were the two it could not measure.

**The two data URIs are answered rather than open.** The sign arrow's baked `%23fff` is a LEGEND, and a legend is scheme-invariant—`$ink-light` is a literal `#ffffff` in all six palettes and the test keeps it that way. The builder pencil's `%23777777` is luck, not design: it is `$neutral-50` on the light ramp and the dark ramp puts that one step away, so the same literal reads on both. The test measures that exact literal in all six, so re-spacing the ramp flags it.

### /brand had gone to zero color tokens and nobody noticed

**A regression this branch shipped.** `/brand` parses `_tokens.scss` and decides "is this a color" with a regex; the theme engine turned every token there into `var(--x)`, so the page rendered **0 color tokens** on a branch whose entire subject was color. It reads the compiled stylesheet's `:root` block for the values now and shows 76 again. Reading the build rather than re-deriving the palette in TypeScript is deliberate—a second implementation of the color math would disagree eventually, and the disagreement would look like a design decision. `test/tokens.test.ts` pins it.

### Still open on the branch

- **The four record marks are placeholders** awaiting Ziad's drawings. Everything else about #136 is done.
- **The colorblind theme is still not a claim the app fully honors**, and the palette still says so. The role chart is now a worked example of the fix—icon and label carrying identity, color redundant—but the second-cue audit across the rest of the app has not been run.
- **Nothing is committed and nothing is pushed.**

### Browser pass, run 2026-08-25

Driven by hand at 1280px and 390px, light and dark, signed in against the local corpus of 17 rides. Role marks, per-role fills, record cards, the count-up, the card grid and the first-run panel all render; no console errors. Two things seen and left: a ride whose thumbnail file is absent locally leaves a grey box of the right shape (a data state on this machine, not a code path), and a long unbroken title like "Davenport/Pescadero" breaks mid-word in the dense track—which is the deliberate trade, since the alternative is a clipped title with no ellipsis reading as a different, shorter place.

## A time is a time is a time—2026-08-24

**Reported as: the roadbook prints 4:00 PM for a day the builder shows as 9:00 AM.** Ziad's call, after three rounds of options were put and rejected: **a time is a time is a time at the departure point.** A rider who plans a 9am departure means 9am where the bike is, whether they planned it from home, from a hotel two states over, or from London a fortnight before flying out. Nothing in the app converts a day's clock into anyone's local time, ever.

**The value is a WALL CLOCK, carried as UTC.** 9am rides in as `2026-08-24T09:00:00.000Z`, `days.start_at` stores `09:00+00`, and every surface reads it back with `timeZone: 'UTC'`. Three of those already did—the roadbook, the export filename, the import preview—as a workaround for this exact bug. They did not change; what they are handed did.

**Two options were rejected on the way and the reasons are worth keeping.** A `days.tz` column storing the planned zone was chosen first and then reversed: it makes 9am correct but leaves the builder's own field showing a converted time, so the two surfaces still disagree for a traveling rider. Rendering in the viewer's zone was rejected outright—a shared California ride would print London times.

**The columns stay `timestamptz` although the values are now naive, and that was measured rather than assumed.** node-postgres parses `timestamp without time zone` in the PROCESS's zone: a stored `09:00` read back on a Pacific machine comes out `16:00Z`, so a real `timestamp` would make the app's behavior depend on `TZ` being set, silently and differently in dev and in the container. `timestamptz` round-trips the exact digits with no type parser and no environment dependency. **The type is a carrier, not a claim about an instant**—that sentence is in the schema comment for the next person.

**A second live bug fell out of the same change.** The stop-details editor wrote a check-in with the browser's offset and read it back by slicing the first 16 characters off the ISO string, so a 3pm check-in typed in California was stored as 22:00 and reloaded into the field as 10pm. Both ends go through the new module now.

**What changed:** `public/js/day-clock.js` is new and is the only place the conversion happens—a ninth pure client helper, `eval`'d by `test/day-clock.test.ts` (22 assertions). `builder.js` delegates its three time functions to it, `ride-time.js` and `map-common.js` format in UTC, and the comments in `date-format.ts`, `roadbook.tsx`, `filename.ts` and `schema.ts` now state the rule instead of apologizing for it. No schema change and no migration file.

**The test forces the process into `America/Los_Angeles` and asserts that it did.** CI runs at UTC, where the code this replaced passes every one of those assertions. If that guard ever fails, fix the zone rather than deleting the check.

**OWED, AND IT IS THE SECOND SILENT DATA MIGRATION IN TWO DAYS.** Every `days.start_at` written before this holds an instant, not a wall clock, so existing rides print hours out and nothing rejects them. `npx tsx utils/shift-days-to-wall-clock.ts --zone America/Los_Angeles --dry-run` reports; without the flag it un-applies the offset across `days` and `point_details`. **It is not idempotent**—a shifted row is indistinguishable from an unshifted one—so it runs exactly once, after a `db-backup`. The local dry run reads two days, `2026-09-12 15:30+00` becoming `08:30+00`.

**Owed: a browser pass**, on the day time fields, the timeline readout, the roadbook, and a stop's check-in and check-out.

**Deliberately not changed:** the account page and the dashboard still render `created_at` and `purge_after` in UTC. Those are real instants rather than wall clocks, and nothing about this decision touches them.

## A POI is on the route—2026-08-24

**Reported as a bug: a new day with a start point and one POI drew two dots and no line.** It was not a bug under the old model—a POI was "near the route and does not affect routing", so there was nothing the router had been asked to join—but the definition was wrong. Ziad's call: **a POI is somewhere you at least ride BY.** An address, or a spot in the middle of nowhere. It is always part of the route; it just is not necessarily somewhere you stop.

**So `legs[i]` joins `points[i]` to `points[i+1]` for both kinds, and `kind` means only "do I stop here".** The second index space—position in the day versus ordinal among the stops—is gone, along with `stopIdx()`, `stopOrdinalAt()`, the projection of POIs onto the day's track, `dayPoiDistances()` in `twist.js`, and the `poiDistsM` argument every schedule caller had to thread through. `stopsOf()` survives on both sides for the four surfaces that genuinely count stops: `rides.stop_count`, the roadbook's numbered rows, the Maps hand-off, and the at-least-one-stop rule.

**What this bought, beyond the report:**

| Before | Now |
| --- | --- |
| Promoting a point rebuilt the legs either side, spent two Routes calls, and threw away the rider's shaping points on both | A flag flip. No leg work, no request, exactly reversible |
| A POI's `dist_from_start_m` was a nearest-vertex projection, null on a trackless import | The prefix sum of the legs before it—exact, and never null on a day with legs |
| `daySchedule()` projected, sorted, and cut a leg at a fraction to place a pause | A plain walk: dwell at `points[i]`, ride `legs[i]`, dwell at `points[i+1]` |
| `activeAt()` returned `stopIndex`/`poiIndex`, each into its own filtered array | One `pointIndex`, into the list the caller already holds |
| The Maps hand-off dropped POIs, so it sent the rider down a different road than the builder drew | Both kinds, batched as before |

**The costs, all accepted and none of them defects.** Adding a POI is a Routes request now, where it used to be free—it splits the leg it lands in. A day's leg count is bounded by `MAX_POINTS` (400) rather than `MAX_STOPS` (200), so up to 399 legs and 399 `route_legs` rows. And `ride.json` lost its deliberate two-array `stops`/`pois` split: the schedule walks points and legs together and two arrays cannot carry the order, so the viewer contract is one ordered `points` array with `kind` on each element. `viewer.js` reads it in one loop and every point now goes through `stopMileages`, which means a POI carrying a `gas` role resets the fuel range like any other point.

**No schema change.** `route_legs` is keyed by `(day_id, position)` and never referenced a stop, so the leg count changing needed no migration—which is exactly why the data migration above is a script rather than a SQL file, and why nothing will fail loudly if it is skipped.

**Native JSON went to 5**, the first bump that is not a rename. A v4 file holds `stops - 1` legs, so `upgradeNativeRide` re-cuts every day's legs from its own track at every point (`relegDay`) and spreads the recorded riding time across them by distance rather than zeroing it. The rider's ORDER is kept rather than re-derived: a v4 POI's place in the list was their own choice, so a point projecting behind its predecessor is clamped forward for a zero-length leg instead of being sorted past it.

**Two latent runtime bugs surfaced and were fixed while in here**, both in `utils/split-imported-legs.ts`, which is not in `tsconfig.json`: it wrote `position: null` for every POI and supplied no `uid` at all. Both columns are `NOT NULL`, so the script would have thrown on the first day it touched. `src/db/seed.ts` and `utils/seed-demo-rides.ts` were also writing the old leg shape and now go through `splitDayTrack`.

**Owed: a browser pass.** Nothing automated covers the map or the builder, and this touched the leg math on every mutation path—add, delete, duplicate, reorder, drag, bulk delete, bulk move, cross-day drag, reverse, and undo.

## POI first: one ordered list of points—2026-08-23

**Every point a rider creates is a POI until they promote it, and a day is ONE ordered array rather than two.** Ziad's call. It replaces a model where the kind was chosen at creation time, from a radio pair on each day's add row—a decision asked for at the moment the rider knows least about the place they just dropped.

**The five decisions, all Ziad's, all 2026-08-23:**

| Decision | What it means |
| --- | --- |
| Creation is unchanged | Click the map, or search on a day's row. No radios, no checkboxes, no kind choice anywhere |
| POI is the baseline type | Every path—map click, either search arm, a saved place—produces a POI |
| The first point of a day is promoted automatically | It becomes a stop and is tagged `start`, which is what keeps "at least one stop per day" true without asking |
| No route line until two stops | Legs connect stops, so three POIs draw three dots and no road. Stated rather than treated as a bug |
| One ordered list, `kind` is a flag | Every point carries `position`, both kinds. Promotion moves nothing |

**Promotion is a row-menu item, both directions**—"Make this a stop" and "Make this a POI". That one was chosen rather than specified: it is the only place that adds no new control, it is keyboard-reachable, and it is reversible, which matters because a mis-promotion would otherwise cost a delete and a re-add and take the point's notes and details with it. **Demoting a day's last stop is offered and disabled**, not hidden—it is a real action that is unavailable for a reason worth stating.

### The migration, which is the part to read before deploying

`drizzle/0008_quick_fat_cobra.sql` makes `points.position` NOT NULL for both kinds, drops `ck_point_stop_pos`, and leaves `uq_point_day_pos` as a real uniqueness constraint rather than one leaning on NULLS DISTINCT to let every POI in a day share a null.

**drizzle-kit generated two statements and both were wrong to run.** It emitted `DROP CONSTRAINT` then a bare `ALTER COLUMN "position" SET NOT NULL`, which fails outright against any populated table—every POI ever written carries null, and nothing in the generated file supplies a value. This is the second time the differ has done exactly this (see 0006) and the second time the rule in AGENTS.md was what caught it.

The hand-written version drops the unique index first, renumbers **both** kinds densely from 0 per day, sets NOT NULL, then rebuilds the index. Stops keep the order they already had; POIs follow them in along-the-route order, which is the order the builder was already displaying them in, so nothing a rider is looking at moves. The index comes out because the renumber deliberately does not trust stop positions to be dense, and a renumber that moves a stop could transiently collide with another—a unique index is checked per row and cannot be deferred.

**Verified against the local database**: 39 days, every one dense from 0, no nulls, no duplicates, and every day still has a stop.

### What changed shape, and the two places that deliberately did not

The payload, the client state and the native JSON all became one ordered `points` array with `kind` on each element. `day.stops`/`day.pois` are gone from `builder.js`; `stopsOf()` on both sides is the only bridge to the leg math, which still counts in stop ordinals because a leg joins stop *i* to stop *i+1*.

**`ride.json` still sends `stops` and `pois` as two arrays, deliberately.** The viewer draws markers and a timeline and never renders points as a sequence, so it gains nothing from the interleaving—and filtering an ordered read preserves each array's order anyway. The payoff is that `viewer.js` was not touched at all. **`ride-time.js` and `twist.js` are shared by both surfaces and now accept EITHER shape**, with `stopsOf`/`poisOf` at the top of each as the only place that difference is known. That is the thing to keep intact: break it and the builder and the viewer disagree about a ride's schedule, silently.

**Native JSON is format version 4, and 2 and 3 still import.** `upgradeNativeRide` merges an older file's two arrays into one list, stops first, stamping each kind explicitly—a v3 stop must not fall through to the `poi` default. Appending rather than interleaving is the honest reading: a v3 POI had no stored order, so there is no sequence to recover. Riders have those files on disk.

### Two rules that had to be re-stated rather than inherited

**"At least one stop per day" is now an explicit refine.** The old schema said it as `stops.min(1)`; `points.min(1)` is satisfied by a day of nothing but POIs, so the guarantee would have been dropped silently. Everything downstream still assumes it—a day with no anchors has no legs, no mileage, no roadbook rows and nothing to hand to Maps.

**The roadbook prints the rider's order now, not the measured distance.** It used to re-sort every row by `distFromStartM`, because a POI had no stored order and its projection onto the track was the only thing that could place it. That projection is now the worse of the two answers: it is null on a trackless import, and a null sorted to the end moved a point the rider had put in the middle. Four tests pinned the old rule and were rewritten to pin the new one rather than patched to pass.

### What a drag means now, and one bug class that went with it

**Dragging is a reorder, for both kinds.** It used to be two different operations: a stop drag reordered, and a POI drag REPOSITIONED the pin to the road midway between the rows it was dropped between, because a POI had no order for a drag to change. That moved a place the rider had chosen, and dropping one back where it started relocated it to the midpoint of its neighbors. `movePoiToDistance()` and the whole midpoint branch are gone.

The index mapping went with it. Every row's `data-i` indexes `day.points` whatever its kind, so Sortable's own indices finally mean something and `orderedRows()` collapsed from an interleave-and-sort to the array itself.

### Verified by hand, not reasoned about

Driven in a browser on a fresh ride and on `/builder/9`: the home seed lands as stop 1 carrying `{start, home}`; two map clicks land as dotted POIs; promoting one draws the route and numbers it 2; demoting works and the last stop's demote is disabled; reorder works for both kinds; save, reload, and the order and kinds come back. The database showed the two distance algorithms correctly split by kind—prefix sum for the stop, projection for the POI.

**Both round trips were exercised against the running app**, not just unit-tested. The v4 native export re-imported to an identical ride: same order, same kinds, 10 legs and 15 points either side. A v3 file reconstructed from it imported correctly too. All four lossy formats still render, and the viewer and the roadbook were checked on the same ride.

### One thing fixed in passing

`utils/seed-demo-rides.ts` had been broken since 0006—it never supplied `uid`, which has been NOT NULL since then. `utils/` is not in `tsconfig.json`, so it fails at runtime with nothing useful to say. It now mints uids and gives POIs positions.

## Saved places—`feat/saved-places`, 2026-08-22

**A rider keeps a library of locations and drops one into any ride.** Home, the good fuel stop, the meet point everyone knows. Closes [#10](https://github.com/feralcreative/routeloop/issues/10). Stacked on `feat/rich-stop-details` rather than branched from `main`, because a place pre-fills a stop's details and those only exist there.

**A place is COPIED into a ride, never referenced, and that is the decision the whole feature turns on.** There is deliberately no `place_id` on `points`. A ride is a record of what the rider planned, so renaming "Bob's Gas" or deleting it must not reach back and rewrite a ride from last year. It also sidesteps the churn problem entirely—points are deleted and re-inserted on every save, so a foreign key from a point to a place would have to survive that for no gain. `placeToStop()` in [src/places/policy.ts](../src/places/policy.ts) is that decision in code, mirrored client-side by `stopFromPlace()` in [public/js/builder.js](../public/js/builder.js).

**The cost, stated plainly so nobody files it as a bug later: fixing a badly placed pin fixes FUTURE rides only.** Rides that already copied it keep the old coordinates. That is the trade, and it was taken knowingly.

**A place carries the durable half of rich stop details and never the per-trip half.** Phone, address, and links are facts about the place. Confirmation numbers and check-in times are facts about one trip, so `placeToStop()` returns an empty confirmation for the rider to fill in—inheriting last September's reservation number would be worse than having none. It returns `details: null` outright when the place has nothing durable to give, so a bare pin does not create an empty `point_details` row in every ride it lands in.

### Groups are optional, and deleting one does not delete its places

`places.group_id` is nullable, because requiring a group would mean inventing a folder before a rider can save their first place—friction in front of the very first use. "Not in a group" is a real section rather than a missing value, and `groupPlaces()` renders it **last**: a rider who has organized their library should see the organization before the leftovers, and it is only drawn when it has something in it.

**The FK is `set null`, not cascade.** Deleting a group keeps its places and makes them ungrouped. Losing a rider's saved locations because they tidied up a folder name would be unforgivable, and cascade is exactly how that would happen. The client says so before it asks.

A duplicate group name answers **409, not 400**—`onConflictDoNothing` on the per-owner unique index, and the sensible answer is "you already have that one" rather than a validation error on a well-formed request.

### Where places surface, and the primitive that was not built

The roadmap asked for "a marker-group primitive in the map engine". **It was not built and it turned out not to be needed.** Saved places surface inside the builder's existing add-row search list, above the Google predictions, matched locally from one character with **no network call and no billing**. There is nothing extra to draw on the map, so there is nothing extra to draw it with. Revisit only if a "show all my places" view is actually wanted.

**Creation happens in the builder, not on the profile**, and that is deliberate: a place needs a pin, and the builder is where the map is. "Save to my places" on any stop's row menu is the creation path. The profile screen manages what is already there—rename, refile, delete, and the groups themselves. A create-from-scratch flow there wants the address picker from item 19 rather than a pair of lat/lng boxes, and should wait for it.

### The privacy shape, which is two layers on purpose

A place library holds a rider's home address and the phone numbers of the places they stay. **There is no public surface here and there should never be one.** Every route is behind `requireActiveApi`, and separately every query in [src/places/service.ts](../src/places/service.ts) folds the owner id into its `WHERE` clause—so a route that lost its gate would return nothing rather than someone else's library. Both layers, deliberately. A group id arriving in a payload is honored only if the rider actually owns that group, or a crafted request could file a place into a stranger's library.

"Not found" and "not yours" answer identically with a 404. A 403 would confirm the row exists.

**Rule-from-query split**, the same one invites, survey, stats, and feedback already use: [policy.ts](../src/places/policy.ts) is pure and holds every rule, [service.ts](../src/places/service.ts) is queries and nothing else. That is what lets `test/places.test.ts` pin the limits, the grouping order, and `placeToStop()` with no Postgres.

Caps are a backstop against a runaway client rather than a product limit: 500 places, 50 groups, 5 links each. A rider with 200 saved places is using the feature as intended; one with 300 has a script. The limits ride along in the list response so the client can disable its own add affordance rather than discovering the cap by being refused.

## Ride thumbnails—roadmap item 28, 2026-08-21

**Written 2026-08-21 and stranded on `style/sign-buttons-and-misc` until 2026-08-24.** [#110](https://github.com/feralcreative/routeloop/pull/110) was meant to carry it and did not—the section was lost in that branch's merge from `main`, and nothing noticed because the code shipped fine. Recovered when the stale branches were cleared. Filed as [#116](https://github.com/feralcreative/routeloop/issues/116).

**Shipped, and it works against the real dev corpus**: every ride in the list now shows a picture of its own route, each day in its own color. 22 tests in `test/thumbnail.test.ts`.

**It needed a Google Cloud change nobody had anticipated, and that is the part worth reading.** Maps Static was one of the 23 APIs switched off on 2026-08-02, so every call came back 403 with *"This API is not activated on your API project"*. That message is **project-level, not key-level**, and the key-level one reads almost identically—the giveaway was that the browser key and the server key returned *different* strings, which is what identified it. Fixed by enabling `static-maps-backend.googleapis.com` on project `tankbag` and adding it to the server key's API restrictions (now Routes + Geocoding + Static Maps). **Restriction changes take a few minutes to propagate**, so a 403 immediately afterwards is not a failure; it cleared on its own.

**The key never enters anything that gets stored.** `thumbnailRequest()` returns the Static Maps path *without* the API key; that keyless string is what gets hashed into `rides.thumb_hash`, and `thumbnailUrl()` appends the key only at fetch time. Two things follow, and both were the reason: a key rotation does not silently invalidate every thumbnail in the database, and no row, log line or error message can carry an IP-restricted server key.

**Simplification targets a point budget, not a tolerance**, because the 8192-character URL limit is a budget and no fixed tolerance maps onto one. Douglas-Peucker with the tolerance binary-searched to land on 330 points. Worst measured case—8 days × 8,473 points—is **2,927 characters, 36% of the limit**.

**A design gap found during the work, and the roadmap said the opposite.** Item 28 claimed a restyle "regenerates every thumbnail by itself, with no migration and no backfill script". It does not. The sweep selects on `updated_at > thumb_built_at` and only compares hashes among rows it has *already* selected—so the hash can prevent work, never cause it, and a style change moves no ride's `updated_at`. `resetThumbnailStamps()` is the backfill, reached as `npx tsx utils/sweep-thumbnails.ts --all --until-done`. The roadmap entry has been corrected rather than left to mislead the next reader.

**This is the app's first scheduler.** An in-process interval, Ziad's call 2026-08-21; `src/auth/mailer.ts` and `src/invites/service.ts` both still say the app has no scheduler and should now be read as "there was none". It runs **once per replica**: at one that is right, at two the hash makes the second pass harmless but the overlap window can double-fetch. That is when it moves to a cron or takes an advisory lock, and the note is at `startThumbnailSweep()`.

**Two sizing facts that look like styling bugs and are not.** Google's wordmark and "Map data ©" line are required by the Maps terms, cannot be styled off, and are drawn at a **fixed pixel size**—so at the original 64×40 display box they were most of the picture, which reads exactly like "the map style is not applying". The fix is the display box (now 160×100) and rendering larger than it (640×400) so the attribution scales down with everything else.

**Still owed:** a quota alert on the Static Maps SKU, which item 28 asks for and which nothing has been set up for. The SKU is Essentials, 10,000 free calls a month, and is separate from the `maps-backend` 500/day cap—so thumbnails do not eat that ceiling.

**Not built, on purpose:** roadmap item 29, cards instead of rows. The thumbnails landed in the existing row layout, which item 29 replaces with a grid across all four browsing surfaces. It is unblocked now.

## Rich stop details—`feat/rich-stop-details`, 2026-08-21

**A stop can carry a confirmation number, check-in and check-out, phone, address, up to five labeled links, and freeform notes**—"gate code 4417, park behind the barn, ask for Dave." Closes [#15](https://github.com/feralcreative/routeloop/issues/15).

**The separate table is the load-bearing part, not an implementation detail.** `points` is what `ride.json` is built from and what every export serializes, so a confirmation number stored as a column on `points` is one forgetful `select()` away from a public share. In its own table it has to be JOINed to leak, and a join is visible in review in a way an extra column inside a `select *` is not. Same reasoning that splits `user_profiles` from `users`.

[src/maps/point-details.ts](../src/maps/point-details.ts) is the only module that reads `point_details`, which makes the boundary greppable: if a surface shows private detail, it imports from there. **`canSeeDetails()` is the entire rule—owner only, and deliberately blind to `visibility`.** A public ride's details are as private as a private ride's, because sharing a route is not sharing a reservation. `detailsForViewer()` returns an empty map rather than null or a throw for a non-owner, so a viewer with no details and a viewer forbidden from seeing them render identically and the presence of details is not itself a signal.

**Details reach exactly three surfaces**: the builder's own load, `ride.json` for the owner, and the native JSON. They are stripped from GPX, KML, GeoJSON, and CSV—those get handed to devices and forwarded to riding buddies, and none of them can express "this field is private". A clone drops them, because a public ride is clonable by anyone. `loadNativeRide()` takes the details map as an argument rather than fetching it, so forgetting to pass it **fails closed**: the export is merely incomplete rather than a leak.

**Verified against a real public ride rather than reasoned about.** A canary detail row was planted on a public ride and all seven anonymous surfaces were fetched and checked—`ride.json`, both native names, and the four lossy formats. Every one returned 200 and none carried it. A second signed-in rider who is not the owner also saw nothing.

### The ID-churn prerequisite was solved differently from the plan

The roadmap's governing text assumed this feature meant "send ids in the payload and diff server-side", which rewrites `insertRideGraph`, `ridePayload`, and `loadRidePayload`—the path the native JSON import shares. **Ziad's call, 2026-08-21: a client-minted `points.uid` instead.**

The delete-and-re-insert model accepted on 2026-08-15 is untouched. `point_details` is keyed by `(ride_id, uid)` rather than by the row id that churns, identity rides along in native JSON exports for free, and `insertRideGraph` barely changed. **Row ids still churn**, so anything else that later needs a point to keep its identity—a comment, a photo—uses the uid too and does not need this revisited.

[src/maps/uid.ts](../src/maps/uid.ts) is the server half: lowercase base36, twelve characters, `randomBytes` with rejection sampling because 256 % 36 = 4 would bias the first four symbols. No uppercase, deliberately—the uid ends up in URLs and hand-typed fixtures, and a case-sensitive identifier that looks case-insensitive is a bug waiting to happen. `uid()` in `public/js/builder.js` mirrors it and **both must agree on the alphabet and the length or the save 400s**.

**`ensureUids()` repairs rather than rejects**, for the same reason `normalize()` repairs alternate groups: the payload arrives from an autosave the rider did not press, so a 400 is a save they silently lost. Three things arrive without usable uids and all three are ordinary—a tab opened before this shipped, a native JSON file written before it, and a ride imported from another app. A duplicate is just as ordinary, since duplicating a stop copies its row wholesale. Uids are settled for a day's stops and POIs **together**, because the unique index is per day across both kinds and settling the lists separately could hand a POI the same uid as a stop.

**`point_details` cascades from `rides`, not from `days`**, which is what makes a confirmation number survive the `delete(days)` at the top of every save. The flip side is that nothing else cleans it up, so `writePointDetails` deletes rows whose uid left the payload. Skip that and a deleted stop's gate code lives forever.

### Fields are shown by role, and a stop with no roles gets all of them

`detailFieldsFor()` in `builder.js` keys off the existing role taxonomy: lodging gets check-in and check-out, a table role gets a reservation time, and everything else gets phone, address, notes, and links. **A stop with no roles at all gets the full set rather than the minimum**—an uncategorized stop is one the rider has not labeled yet, and hiding fields from it looks like a bug.

The builder edits them behind a row-menu item and badges the rows that carry any. The viewer shows them as a ruled-off block headed "Only you can see this".

**One snapshot note that generalizes.** `point.details` had to join `point.roles` in the copied-not-shared half of the builder's undo snapshot, because the field editor assigns into that object one field at a time and `details.links` is an array it pushes to. That set changes every time an edit-in-place feature ships, and nothing fails loudly when it is missed.

## Sign buttons, widows, and a spelling sweep—`style/sign-buttons-and-misc`, 2026-08-19

**Three unrelated pieces of work on one branch, and the commit history does not separate them cleanly.** Read the commit hygiene note at the end of this section before rewriting any of it.

### The sign-button treatment spread

`.btn-sign` existed but was used on exactly one control, the sign-in submit. It is now the standard treatment for a page's primary action:

| Where | Classes |
| --- | --- |
| `/rides`, Plan a ride | `btn btn-sign arrow-right arrow-s` |
| `/settings`, Save | `btn btn-sign arrow-right arrow-n` |
| `/settings`, Download Me | `btn btn-sign` (left side, west arrow, both defaults) |
| `/account/delete`, Save Me | `btn btn-sign` |
| `/settings`, Delete Me | `btn btn-sign btn-stop`, the new octagon |

**`.btn-stop` is new and is the only control in the app with a clipped shape.** A regular octagon, red field, white keyline inset 3px and 5px—the same absolute values the guide sign uses, because those are what tie the two together. Two things could not be inherited and are rebuilt in [style/\_chrome.scss](../style/_chrome.scss): the keyline, because inset shadows follow `border-radius` rather than a `clip-path` and would have kept rectangular corners, and the focus ring, because `clip-path` clips an outline—`:focus-visible` recolors the keyline to `$accent` instead. The ring is three concentric octagons with no extra markup, using `::before` (free here, since a stop sign carries no arrow) and `::after` at `z-index: -1` under a stacking context the button makes for itself.

**The GTFO rows are a grid now, not a flex row.** `justify-content: space-between` was lining up the controls' right EDGES, and with three different widths that put three different centers down the column. `grid-template-columns: minmax(0, 1fr) 12rem` with `justify-self: center` on the control lines up the centers instead. The track is fixed rather than `max-content` because each row is its own grid—content-sizing would size it to that row's own control and undo the whole point.

**The gotcha that cost the most time is now in [AGENTS.md](../AGENTS.md): there is no global `border-box` reset in this stylesheet.** `width` and `aspect-ratio` on the octagon were describing the CONTENT box while 1.5rem of padding sat outside them, so the sign rendered 24px wider than it declared and its legend could never wrap. Every fixed-size box in the app sets its own `box-sizing`; a new one that forgets is 24px too big and nothing says so.

### Widows have a policy now

**CSS first, `&nbsp;` only where CSS cannot reach.** `text-wrap: pretty` is set on body copy in [style/\_base.scss](../style/_base.scss) and covers every page a browser renders, so page copy needs nothing hand-placed. It degrades silently, which is why it can sit there unguarded—**Firefox has still not shipped it as of August 2026**, and no mail client has.

The two surfaces outside it bind their own last two words instead: `src/emails/` and the printed roadbook. Five templates were touched; `owner-feedback` and `feedback-status` deliberately have none, because their copy is all interpolated props, ends in a URL, or is the rider's verbatim quote. Rendering all seven confirms exactly one bound pair each where intended.

**Two mechanisms, and which to use is decided by the copy, not by taste.** In static JSX write `&nbsp;` straight into the markup—**esbuild decodes the entity to U+00A0 while transpiling, verified rather than assumed**. For a string shared between an email's HTML and text arms, use `noWidow()` from [src/views/widow.ts](../src/views/widow.ts), so only the HTML arm carries the character; a `text/plain` part must not. Seven tests in `test/widow.test.ts`, including one pinning that it is deliberately **not** idempotent.

Never put a raw U+00A0 in source. It is invisible in a diff, so a stray one is unreviewable and a stripped one is undetectable. Also worth knowing: the em-dash tightener counts a non-breaking space as whitespace on both sides of a dash, so a pair bound across an em dash is silently undone by the pre-commit hook.

### British to American, 208 replacements across 73 files

Every hit was verified as prose, a comment, or a test name before anything was written—no identifiers, no data keys, nothing in `drizzle/` or `utils/deploy/sql/`, and the SCSS token `$grey` untouched because AGENTS.md sanctions it. Case preserved, including three all-caps comment headers.

**Three things were deliberately left in British spelling, and a future sweep must leave them alone**, because in each the spelling *is* the subject: the `` `color`, not `colour` `` example inside the rule statement in AGENTS.md, the ROADMAP row whose entire content is `"colours" → "colors"`, and the verbatim quotations from MyRoute-app's forum and support docs in [myrouteapp-formats.md](myrouteapp-formats.md), whose surrounding prose was corrected.

### What is owed, and one thing to know about the history

- **No browser pass on any of it.** Port 6686 was held by another process all session, so the dev server in the repo's tmux window sat in a crash loop and nothing here was seen rendered. The sign buttons, the octagon, and the GTFO grid are all layout changes that nothing automated covers.
- **Commit hygiene.** `90b066e` is titled "correct British spellings across the repo" and its 84 files also carry the entire widow policy and most of the sign-button work, because it was staged with `git add -A`. The words in it are accurate; the title is not the whole commit. Squash on the PR, or split it before opening one.
- The branch also carries `fd0fca1`, the panel exit X becoming an "Exit map" menu item. **That is not part of this work**—it was already committed when this session started.

## The `alt`/`alts` rename—2026-08-18

**Done, and the whole thing is mechanical.** Three files renamed with `git mv` and five identifiers rewritten; `npm run typecheck`, `npm test` (1,076 passing across 44 files, 2 skipped) and `npm run check:dashes` all pass, and the two client files typecheck cannot see were verified by loading the builder and the viewer in a browser.

| Was | Is |
| --- | --- |
| `src/maps/alternates.ts` | `src/maps/alts.ts` |
| `public/js/alternates.js` | `public/js/alts.js` |
| `test/alternates.test.ts` | `test/alts.test.ts` |
| `hiddenAlternates` | `hiddenAlts` |
| `isLosingAlternate` | `isLosingAlt` |
| `promoteAlternate` | `promoteAlt` |
| `ungroupAlternates` | `ungroupAlts` |
| `groupSelectedAsAlternates` | `groupSelectedAsAlts` |

Both traps the previous handoff named turned out to be real, and both are closed. `hiddenAlts` is a field on the `ExportRide` type, so it was renamed everywhere it is constructed—`src/maps/export.ts` plus the six test fixtures that build an `ExportRide` by hand—but it is internal to that type and reaches no wire format, so nothing a rider has downloaded changes. And the script lists are the half `npm run typecheck` cannot see: `public/js/alts.js` is loaded by path from [src/index.tsx](../src/index.tsx) and [src/routes/builder.ts](../src/routes/builder.ts), both updated, both confirmed by loading `/builder/9` and `/m/:slug` and seeing `/js/alts.js` fetched, `window.TBAlt` resolve, and no console errors on either page.

**`window.TBAlt` was already correct** and did not move, which is why the client half of the rename is only the file path.

Two notes for whoever reads the diff. The import in `test/alts.test.ts` collapsed from six lines to one because the shorter module path now fits inside prettier's 120 columns—that is prettier's doing, not a hand edit. And six comment paragraphs were re-wrapped where the shorter name left a short line mid-paragraph; the committed tree is not prettier-clean under the current config, so the reflow was done by hand at the file's own 80-column comment width rather than by running a formatter across the files.

## The mobile pass—2026-08-18, emulated only, and the three fixes

**Read this section for what it did NOT cover first.** There is still no device pass. Everything below was measured in Chrome under device emulation at 393×852, 412×915, 700×900, and 852×393 landscape, which is honest about layout, geometry, tap-target size, overflow, and contrast, and says nothing at all about the things [rider-feedback.md](rider-feedback.md) actually asks for. **Still needing hardware, unchanged:** iOS Safari's engine (the visual-viewport and keyboard interaction, `position: sticky` under an open keyboard, tab eviction), the installed-as-PWA context on either OS and the display-mode field the diagnostics record from it, the real photo pickers (iOS HEIC, Android's chooser, and the client-side shrink on a camera-sized file), and tap accuracy with gloves on.

**Three defects, all portrait-phone, all reproducible in emulation, and all three now fixed.** The fixes are CSS only—no markup, no JavaScript, no test touched—and each one is re-measured below.

**1. The feedback FAB sits on top of the builder's day sheet and covers a stop's fields.** This is the one worth fixing first. `.fb-fab` carries `z-index: $z-map-panel` with the comment *"the panel's layer; they never overlap horizontally"* ([style/_feedback.scss:413](../style/_feedback.scss#L413)). That is true on a wide screen, where `#info-panel` is a 380px left drawer and the button is at `right: 72px`. It stops being true at `max-width: 767px`, where [style/_map.scss:831](../style/_map.scss#L831) turns the panel into a full-width bottom sheet—`left: 0; right: 0; bottom: 0`, `height: clamp(320px, 62vh, …)`. `.map-timeline` was taught about that sheet in the same media query and gets an extra `bottom` term to clear it; the FAB was not. Measured on `/builder/9`: at 393×852 the button lands on a `.row-dur` input, and at 700×900—inside the band where the FAB still shows its label and is 153px wide, because its own breakpoint is 600px while the sheet's is 767px—it covers a `.row-name` and a `.row-dur` together. Collapsing the sheet does not help; the button then overlaps the collapsed header instead, which is only cosmetic. The viewer is affected by the same rule but currently lands on empty panel space rather than a control. Landscape at 852×393 was already clean—the panel is a left drawer again and the button clears Google's zoom cluster by 22px and the attribution strip entirely.

**Fixed** by giving the button the treatment `.map-timeline` already had. The sheet's two footprints are now declared once in `_map.scss` as `--sheet-height` and `--sheet-collapsed-height` and read from there, so the `clamp()` that used to be written out twice cannot drift; the FAB's `bottom` is `--panel-inset` plus whichever footprint applies plus a timeline term that collapses to zero when the bar is `[hidden]`. Re-measured on `/builder/9`: at 393×852 the button clears the open sheet by 16px and the collapsed one by 16px, at 700×900 it clears by 66px, and with the timeline forced visible it steps up again to sit above the bar with no overlap on either. Desktop at 1280×800 still computes `bottom: 32px`, unchanged.

**And a second bug the fix itself exposed, which is why the media query has a companion.** `--sheet-height` has a 320px floor, so a phone held landscape at 740×360 gives the sheet 320px and leaves 40px of map—less than a 44px button needs. Lifting it there put it 27px off the top of the screen, which is worse than the overlap. Below `max-height: 400px` the button is hidden outright and the account menu is the way in, which is the reason the flow was built with two entry points rather than one. Verified: hidden at 740×360, back and clear by 23px at 740×420.

**2. Step one of the bug flow puts Next below the fold once the keyboard is up.** At a 516px visual viewport—393×852 less a typical iOS keyboard—the textarea ends at 423px and the Next button spans 570–630px, so it is 114px past the fold and the rider has to scroll with the keyboard open. This is exactly the failure `rider-feedback.md` predicted, and it is worth saying that the plan's own remedy is not obviously right: it asks for a send button that is *"full-width, 60px, bottom-anchored above the keyboard"*, and a bottom-anchored button is the classic iOS Safari trap, because a `position: sticky` bottom element sticks to the layout viewport and the keyboard covers it. The button is 60px tall as specified but 93px wide and in normal flow.

**Fixed, and the reasoning matters more than the rule.** The action row is now sticky on every screen rather than only the last, because `.fb-flow .fb-send` was *already* sticky on the last screen—so the bet that a pinned bottom control is right here had been made and shipped, and the first screen was simply not getting it. Extending an existing decision beats introducing a competing one. The rule is `.fb-flow .fb-actions:not(:has(.fb-send))`; the `:has()` is load-bearing, because `.fb-send` is itself sticky and a sticky box inside a sticky box resolves against the wrong containing block. Re-measured at 393×516: Next now sits at 432–492, fully visible with no scrolling. At 393×852 nothing moves—sticky only ever pushes an element up, and at full height the row is already above the threshold—so the screen that was fine stays exactly as it was. Confirmed the last screen is untouched: its `.fb-actions` computes `static` and `.fb-send` is still `sticky` at 329×60, and a report submitted end to end from the sticky row.

**The one cost, stated plainly:** the "Something like…" example paragraph now scrolls under the pinned row on a short viewport. That is ordinary sticky-footer behavior and the hint is one scroll away, but it is a real trade and it was not free.

**3. The escape hatch is a 26px target inside a flow whose own rule is 44px.** [style/_feedback.scss:14](../style/_feedback.scss#L14) states the rule outright—*"Every target here is bigger than the app's, because the hands using it are gloved"*—and the flow keeps it: the three kind cards measure 348×95, the chips 60px tall, the final Send it 329×60 and sticky. "Just start typing →" is 144×26, because it renders as a plain `.linkbtn` and never picked up the flow's sizing. Small, and it is the one control on that screen a rider reaches for when the three big ones did not fit. **Fixed**: `.fb-escape` is a flex row now and its button carries `min-height: 44px`, measured at 161×44.

**What the emulated pass confirmed is right**, so nobody re-checks it: the photo input is `accept="image/*" multiple` with **no** `capture` attribute, which is what the plan requires; the textarea is 17px so iOS will not zoom on focus, and carries `enterkeyhint="next"` and `autocapitalize="sentences"`; the bright-sun decision holds under `prefers-color-scheme: dark`, where the flow still renders white on `#333` at 12.63:1—and there is no dark theme in the app yet, so `.feedback-flow` is a marker for the one that arrives rather than an override doing work today; no page in the flow overflows horizontally at 393 or 412; `/board` and `/feedback/mine` are clean at phone width with no sub-44px targets; and the bug flow submits end to end at 393px.

**One code-level finding that needs no device, and it is not a bug today.** [style/_feedback.scss:218](../style/_feedback.scss#L218) and [:412](../style/_feedback.scss#L412) both add `env(safe-area-inset-bottom, 0px)`, and the comment above the first says it *"keeps it clear of the home indicator"*. Those insets resolve to `0px` unless the page opts in with `viewport-fit=cover`, and [src/views/layout.tsx:560](../src/views/layout.tsx#L560) ships `width=device-width, initial-scale=1` and nothing else. Nothing is broken, because iOS insets the layout viewport itself at the default `viewport-fit=auto`—but the term is inert, the comment describes a mechanism that is not running, and the day somebody adds `viewport-fit=cover` for an edge-to-edge map the two numbers start mattering. Decide it deliberately rather than discovering it.

**Two more, reported by Ziad and fixed the same day, both in the drawer header on a phone.**

**The collapse and expand arrows pointed along the wrong axis.** Both glyphs are drawn for the desktop drawer, which slides sideways—`icon-collapse.svg` is a bar on the left with an arrow into it, `icon-expand.svg` a bracket on the right with an arrow out of it. At `max-width: 767px` the panel is a sheet that travels *down*, so the arrows were describing a motion that does not happen. One `rotate(-90deg)` on `.collapse-icon` inside that media query turns both correctly at once, because the two are the same drawing mirrored: counter-clockwise sends the collapse arrow down onto a bar along the bottom edge, and the expand arrow up out of a bracket along the top. Rotating beats shipping a second pair of files—it keeps one copy of each drawing, which is the same reason they are masks rather than `<img>` in the first place. Desktop computes `transform: none` and the 56px rail is untouched.

**And the X sat 6px up and 6px left of the arrow beside it.** `#info-panel.collapsed` in the phone block listed `.drawer-logo` and `.panel-exit` together and gave both `display: block`, to bring back what the desktop rail hides. The logo wants `block`; the exit does not. `display` is the property the shared rule near the top of the file uses to make that button a centering flex box, so `block` un-hid the control and silently dropped the centering with it—the `::before` is a bare 18px box with `margin: 0`, so the X went to the top-left corner of its own 30px button while the arrow next door stayed centered. The two selectors are separate now. **The lesson generalizes: a rule that re-shows something by setting `display` has to restore the exact value, not a plausible one.** Both controls now share a center line in both states, on the builder and the viewer.

**And the collapse never animated at all.** Reported as "ease that collapse animation"; the finding was that there was nothing to ease. `#info-panel` declared `transition: height 0.28s cubic-bezier(0.4, 0, 0.2, 1)` against a collapsed state of `height: auto`, and a length cannot be interpolated toward a keyword—so the declaration sat there doing nothing while the sheet jumped 528px to 52px in a single frame. Measured before the change: 33 samples across 500ms, every one already at the collapsed height. The desktop drawer was never affected, because it animates `width` between two real lengths.

**The sheet slides now instead of shrinking.** `transform: translateY()` rather than a pair of explicit heights, because a translate runs on the compositor and never touches layout, where animating height would re-lay-out a drawer holding every day of the ride on every frame. 0.34s against the drawer's 0.28s, because the travel is longer—about 476px against 324px—and the same easing, so the two read as one piece of furniture moving two ways. Measured after: 21 distinct positions over the 340ms, 324 → 800, on the builder and the viewer alike, settling at exactly the position the old jump landed on. The `prefers-reduced-motion` rule already covered `#info-panel` and now covers the sheet's contents too.

**Two things had to move with it**, or they arrived first and waited. The feedback button and the timeline bar both read their `bottom` from the sheet's height, and both switched value on the class toggle with no transition of their own—so they teleported to the far end of the travel on frame one while the sheet was still going. Both now carry the slide's duration and easing. Verified frame by frame: the button clears the sheet on every one of the 21 frames, not just at the two ends.

**The real repair was structural, and it retires a bug class rather than an instance.** The sheet has to keep its contents while it travels—an empty white box sliding away is a worse animation than none—so they could no longer be `display: none`. The shared `.collapsed` rule hid five elements for the desktop rail, and the phone block had been un-hiding them one at a time by restating `display`. **A restated value is a value somebody has to guess, and both guesses were wrong**: `.panel-exit` was guessed as `block` and lost the flex centering (that is the X misalignment above), and `.panel-title` cannot be guessed at all, because the viewer wants `flex` where the builder overrides it to `block`—forcing either one reflowed the heading mid-slide. The hiding is now scoped to `min-width: 768px`, the widths that actually have a rail. The phone inherits every natural value and restates nothing; four `display` overrides were deleted rather than added to. What `display: none` was doing for free—keeping the off-screen list out of the tab order—is now an explicit `visibility: hidden` delayed by the length of the slide.

**One dormant rule woke up and had to be scoped too.** `&.collapsed .panel-title #ride-title` in `_builder.scss` shrinks the heading to one line for the rail, and has been inert since the redesign gave the rail `display: none` on that element. Re-showing the title on the phone woke it, and it reflowed the heading from two lines to one on the first frame of the slide. It is scoped to `min-width: 768px` now and kept rather than deleted, because it still describes what the heading should do if the rail ever shows it again.

**And then the exit control went entirely.** Ziad's call: an X in the drawer header serves no purpose there. The two controls sat a millimeter apart and read as a pair, and they are not one—collapse keeps you on the map, exit leaves it—so the more consequential of the two was the easier to hit by mistake. It is `Exit map` now, **first in the menu**, above the `Rides` group, pointing at `/rides` signed in and `/` signed out.

- **Removed from both panels, not just the builder.** The reasoning does not change between the two, and one X left behind would have meant two ways out that disagree about where they live.
- **`exitHref` and `exitLabel` are gone from `panelShell`.** The destination is a function of whether a rider is signed in and nothing else, so `SiteHeader` works it out from the `user` it already has and both call sites stop passing anything. The item renders off the same `isMap` flag that decides whether the header draws a logo—one answer to "is this a map page" rather than two that can disagree.
- **`docs/main-menu.md` was updated first**, because `layout.tsx` says outright that the file is the spec and the code is the implementation. The decision is recorded there.
- **What survived the deletion:** `icon-close.svg` is still masked for `.day-del`, which was the other half of that shared rule and is easy to take out with it. `.panel-controls` is a single 30px control now.
- Verified on the builder and the viewer, signed in and signed out, at 393px and 1280px: no `.panel-exit` in the DOM, the item first in the nav with the right href in each case, and absent entirely on a non-map page.

**Outside the feedback scope, but the same rider on the same phone:** the viewer's panel at 393px is full of targets under 44px, and the worst are the day-visibility checkboxes at **13×13**. The per-day export buttons are 31×21, the zip links 21×16, and the collapse and exit controls 30×30. None of this shipped with the feedback sprint and none of it is a regression, but it is the surface a rider uses at a gas stop and it is worth its own pass.

## The alternates walkthrough, finally done—2026-08-16

The day-level alternates shipped on 2026-08-16 without the manual pass its own plan called for, because the feedback sprint was called immediately afterwards. That pass has now been run against `main`, on ride 9 (`Bodega Bay via the back roads`, 4 days, 500.3 mi). **All six checks pass.**

- **Grouping drops the ride total.** Days 2 and 3 grouped: 4 days / 500.3 mi became 3 days / 444.7 mi, renumbered 1, 2, 2b, 3.
- **The group survives a reload.** Stored as `alt_group = 0` on both with one `alt_active`, and `rides.total_miles` cached at 444.7 with the ghost excluded. This is the `loadRidePayload` / `loadExisting` pair the plan names as the silent-failure risk, and it holds.
- **Promoting a losing alternate moves the total.** 444.7 → 306.3 mi.
- **Deleting the active member dissolves the group, silently.** All three remaining days came back `alt_group = NULL`, no error raised, total recomputed. `resolveAltGroups` step 3 as specified.
- **Every lossy surface drops the losing alternate.** GPX, KML, GeoJSON, CSV, the roadbook and the hand-off page: zero of three ghost-exclusive stop names present.
- **Both lossless surfaces keep it.** Native JSON and `ride.json`: three of three.

**A note on how to run that export check, because the obvious way is wrong.** A first pass grepped each export for the ghost day's stop names and reported leaks in all five lossy formats. Every one was a substring false positive—"Healdsburg" also occurs inside "The dispersed spot, Healdsburg" on an *active* day, and "Bodega Bay" is part of the ride title. Only names that appear on the ghost and **nowhere else in the document** prove anything. Same trap as the banned-word matching in `test/feedback-status-labels.test.ts`.

**The walkthrough raised a naming question, and Ziad settled it: in code it is `alt` and `alts`; front-end copy is his to write and is not constrained.** The walkthrough had flagged the UI saying "alternative" as a defect. **It is not one**—do not file it, and do not rewrite copy to match identifiers.

What that left was a mechanical rename, done on 2026-08-18 and recorded in the next section.

## Rider feedback, end to end—`feat/rider-feedback`, 2026-08-16

**The whole feature shipped in one branch: intake, owner queue, public board, wants, status emails and duplicate merging.** A rider can report a bug, propose an idea or ask a question from inside the app; the owner triages at `/admin/feedback`; published ideas appear on `/board` where riders vote with "I want this". Built to the plan in [rider-feedback.md](rider-feedback.md), which was written before any of it and held up—the deviations are listed below rather than folded away.

**Four gates in that plan were open and all four were decided on 2026-08-16.** Entry point: **both**—an account-menu item plus a floating button on the builder and viewer that pre-fills `?area=`. Map state: **a plain object on `window`**, so `public/js/map-common.js` stays the only file naming `google.maps` and the boundary is untouched. Bright sun: **light-mode-first regardless of the system theme**, carried by the `feedback-flow` body class. The board: **shipped now** rather than held back.

**Screenshots are a file input and nothing else, and the reasoning changed.** The plan ruled out DOM-capture libraries because Google Maps composites through WebGL and hands back a blank rectangle. BugHerd-style capture came up during the build and was checked properly: it uses `getDisplayMedia()`, which *would* capture the map correctly because it captures the composited frame—but it is unsupported on **every** mobile browser (iOS Safari, Android Chrome, Android Firefox, Samsung Internet, all current versions), and this flow's audience is riders on phones. The plan's conclusion survives; the reason is now stronger than "no library can do it".

**Four things a reader should not have to rediscover:**

- **`state` and `status` are two columns, and that pair IS the private-bug feature.** Nothing is visible to anyone but its author and the owner until `state = 'published'`, and nothing publishes a bug by default. There is no separate private-bug mechanism to find.
- **Wants are deduplicated by Postgres, never by application code.** The composite primary key on `feedback_votes` is the one-per-rider guarantee; the toggle reads what it actually wrote rather than asking first; `mergeDuplicate` transfers votes with `INSERT … SELECT … ON CONFLICT DO NOTHING`. Verified with an overlapping voter: {2,1} merged into {3,1,4} gives 4 unique riders, not 5.
- **Diagnostics are redacted on the way in, never on the way out.** A redaction applied at render time is not a redaction—the data is already stored and already in a backup. `src/feedback/diagnostics.ts` is the only way in.
- **The queue is several small forms on purpose.** `moderate()` writes only the fields it is given, so saving a private note cannot blank a public response. One wide form would.

**Deviations from the plan, all deliberate:**

- `GET /feedback/:publicId/photo/:n` was added—it is not in the plan's route table, and without it the queue can store an image and never show one.
- The owner alert is `src/emails/owner-feedback.tsx`, not the plan's `feedback-received.tsx`, following `owner-signup.tsx`: in that directory the `owner-` prefix means "written for the person running the site".
- `feedback-buffer.js` loads on **every** page rather than with the flow, because by the time a rider decides to report something the error happened minutes ago on another screen.
- A `kind` picker was added to the queue, because the "Just start typing" escape hatch stores `bug` and reclassifying has to be possible somewhere.
- The plan's 90-day diagnostics retention is **not implemented**, and the privacy page says so rather than naming a window nothing enforces. Diagnostics are deleted with the account by cascade.

**Three bugs found by running it, none visible to `tsc`:** `wantedBy` crashed every board render because a JS array interpolated into a tagged `sql` template expands to a tuple (`inArray` is the fix); a double-tap on a want 500'd on the primary key (`onConflictDoNothing` plus reading what was inserted); and the floating button sat on Google's zoom controls, which occupy the entire right edge of the map from y≈823 down to the attribution strip.

**Not verified: no email has actually been delivered.** SMTP is unconfigured locally, so every send logs "skipped: mail is not configured" and returns. The call paths are wired and do not break the flows they hang off, but the sends themselves are untested until they run somewhere with `SMTP_*` set.

## Alternate days, and the drawer—`feat/fixed-day-slider`, 2026-08-16

**The alternate object from roadmap item 14 shipped, at day level, for a single planner.** Two or more days can be grouped as alternatives of one another; exactly one is active; only the active one counts toward any mileage, duration or stop count anywhere in the app. Losing alternates are kept, drawn dashed on the map, badged in the viewer legend and the builder, and excluded from the roadbook, the hand-off page and all four lossy export formats. The native JSON keeps everything. **Voting, resolution and vote scoping are not built**—that is the half of item 14 that still depends on riders (item 8).

Two columns on `days`, `alt_group smallint NULL` and `alt_active boolean NOT NULL DEFAULT true`, plus the partial unique index `uq_day_alt_active`, in `drizzle/0003_sticky_firebird.sql`. No backfill was needed—the defaults describe every pre-existing row correctly. The rule lives in `src/maps/alts.ts`, mirrored by `public/js/alts.js` and pinned by `test/alts.test.ts` (renamed 2026-08-18; it was `alternates.*` when this shipped).

**`setRouteDim` could not be reused for ghosting, and this is the design note worth keeping.** `entry.dim` is already owned by day focus in the builder and by hover and the timeline in the viewer, so ghosting through it un-ghosts an alternate the instant it is focused. `map-common.js` gained a third state, `entry.ghost`, drawn dashed with no direction arrows—a different *kind* of line, because opacity already means "not focused".

**The branch carried more than the alternates.** Fourteen feature and style commits in all, and the ones outside the alternates work were not in the hand-off summary: the floating panel became **a left drawer showing every day** (`eda5b7c`), every day gained **its own search row** and the global search box went (`ec89103`), a **day menu and select mode** with bulk day and point actions landed (`6f97a66`), the AI-generated icons were **replaced with human-drawn ones** and the day header tightened to a measured 10px (`8e5a6e8`, `efa16a7`), and `moto-storage` was renamed **`storage`** (`545fa81`). Those are recorded here from their commit messages rather than from a read of the diffs—the alternates detail above came from the implementing agent's own hand-off and was verified against the schema, the files and the suite.

**Suite: 929 passing across 39 files**, 2 skipped, 931 total—verified 2026-08-16, up from 869 across 37.

## The builder panel redesign—epic #88, all five phases, 2026-08-15

Nothing in this section is deployed, but it is no longer local: `feat/builder-panel` merged to `main` via [#106](https://github.com/feralcreative/routeloop/pull/106) on 2026-08-15. Read it as history rather than as the current shape of the panel—`feat/fixed-day-slider` has since replaced the floating panel with a left drawer showing every day, and the day slider this section describes is gone.

The panel is the app's primary work surface and had never been designed as one—it grew a control at a time. A measured pass on 2026-08-10 against `/builder/9` found **380px wide holding 198 interactive elements, with 807px of content in a 620px window** on a 3-day ride with 7 stops on the focused day. That measurement became [ROADMAP](ROADMAP.md) item 16 and then epic [#88](https://github.com/feralcreative/routeloop/issues/88). Re-measured on the same ride, the same day and the same viewport after four phases: **380px, 180 elements, 618px of content in a 617px window**—the seven-stop day fits without scrolling, where it used to overflow by 187px. The width is unchanged on purpose; it was never the complaint.

**The governing rule the whole epic runs on: nothing in the panel changes size as its value changes.** Reserve the space, fix the footprint, let the content fit the box. Every fixed width and `min-height` that looks arbitrary in `_builder.scss` is that rule—`.save-status` at 15ch, `.row-roles-btn` square, `.day-times-note` reserving a line it is often not using. Do not "clean up" one of them without knowing which readout it is holding still.

Phase by phase, and what to know about each:

1. **Autosave, and the Save button is gone** (#89, #90). Two timers, not one: a 3s idle debounce and a **20s ceiling** armed on the first edit of a dirty run. The ceiling is the one that matters—an idle debounce alone has no upper bound, so dragging a stop around for four minutes never goes idle and never saves. The route request keeps its own separate debounce in `computeLeg()`; that is the half that costs money and it is deliberately not coupled to this. Discard went with Save; undo/redo replaces it.
2. **The ride's name is the headline, and the panel has a way out** (#94, #91). The field **is** the heading rather than something a pencil reveals—a reveal would be a second mode and a layout jump. Half of #91 turned out to be wrong: the existing control was never an X, it is a minimize glyph, so collapse did not have to move. What was real was that there was **no exit at all** from a map page except the nav hamburger. There are two controls for two verbs now, on the viewer as well. **Superseded 2026-08-19**—the exit control is gone from both panels and the verb it carried is `Exit map`, first in the menu. See the section below.
3. **The row** (#98, #97, #92, #39). Six buttons became two, a drag tab and a `⋯`. Role icons hold one icon's footprint whatever the role count. **The index mapping was the whole job of drag-to-reorder**: `orderedRows()` interleaves stops and POIs by distance along the track while each row's `data-i` indexes its own array, so Sortable's `oldIndex`/`newIndex` mean nothing—reading the DOM order of the stop rows and taking their `data-i` sidesteps the interleaving. A POI drags too, and dragging one **moves its pin** rather than reordering it, because a POI's place is projected and not stored.
4. **The timeline left the panel** (#93). It is a bar across the bottom edge of the map now, on both pages—see the next section.
5. **Stop durations are a preference** (#96). The last one, the smallest, and the only one with a schema change—see the section below that.

The epic is closed. What it did not do, deliberately: the panel is still 380px wide, because the width was never the complaint.

### The ride timeline moved to the map's bottom edge

`rideTimeline()` in [layout.tsx](../src/views/layout.tsx) renders it once and both map shells drop it into the page body **beside** `#info-panel` rather than inside it. Five things worth knowing before touching it:

- **It is not a mode split.** The open question on the roadmap assumed the two sliders had to become a view mode and an edit mode, which would have put the timeline out of reach while planning—a change to a stated headline feature. Wrong axis: the day scrubber picks what you are **editing** and the timeline moves through what you are **looking at**, so they separated by place. The scrubber stayed in the panel.
- **The move cost almost no JS** because both clients reach `#time-slider` and `#time-readout` by `getElementById` and neither walks up from them. Keep it that way.
- **It hides now rather than going inert.** In the panel it stayed put and went disabled, because vanishing would have reflowed every control under it. Over the map there is nothing under it, so a dead slider lying across someone's route is the worse of the two. The hint it used to carry moved to `#day-times-note`, beside the Starts field that fixes it.
- **The bottom edge is not empty.** Google's wordmark and the attribution row are a **license condition** and may not be covered; the zoom and recenter buttons own a gutter at RIGHT_BOTTOM. Both are declared as custom properties on `html.map-page` (`--map-credit-height`, `--map-control-gutter`) and the bar's offsets are calculated from them. This was caught by measuring on a phone, where the first version covered all three.
- **`--panel-inset`, `--panel-width` and the rest moved from `#info-panel` to `html.map-page`.** They had to: the bar is a sibling of the panel, and a custom property inherits down, not sideways.

The heading came down 25% at the same time (2.1rem → 1.575rem, on both panels) and **`#ride-title` is a `<textarea>` now, not an `<input>`.** That is the only way a heading wraps—an `<input>` is single-line by definition and will only ever ellipsize. It costs three things, all handled in `builder.js`: Enter is swallowed, pasted newlines are flattened, and `fitTitle()` sets the height from `scrollHeight` on every edit because a textarea does not size itself. The two-line ceiling is a `max-height` in SCSS; collapsed, one line, faded out at the right edge because `text-overflow: ellipsis` does not apply to a textarea.

### Stop durations are a preference, and Settings has its first real content

`src/maps/duration.ts` owns the rule, `public/js/duration.js` mirrors it for the browser, and `test/duration.test.ts` runs both over the same fixtures. Same arrangement as `twist.ts`/`twist.js` and `filename.ts`/`filename.js`, and the same instruction if that test fails: bring the two back into line, never loosen the assertion.

**There turned out to be a third copy nobody had counted.** `fmtDuration()` in `src/routes/roadbook.tsx` has printed `4h 20m` since the roadbook was built, and its own comment records the exact complaint issue #96 was filed about—"an overnight camp stop printed 658m before this, which nobody parses at a glance". The builder never got that fix, so the same stop read `658` in the panel and `10h 58m` on the printout. The `hm` format is defined as agreeing with the roadbook rather than the other way round, and the test walks every minute of a day to prove it.

Three things to know before touching this:

- **Storage did not change and must not.** `points.duration_min` is integer minutes. Verified by switching the preference three ways against the same ride and reading the same numbers back, and by checking the roadbook prints identically at every setting.
- **The field is `type="text"`.** "1h 30m" is not a number, and switching the input's type per format would be three code paths through every read and write of that field; `inputmode` comes off the format instead and the phone keyboard is still right. That lost `max="43200"` from the markup, so the ceiling moved into the parser—where it **clamps rather than refuses**, because `800h` settling to `720h 0m` on blur says what happened, and letting it through 400s the ride's next autosave on a field nothing points at.
- **Parse on every keystroke, reformat on none of them.** Rewriting the field as it is typed strands the caret and actively breaks two formats: `1.` becomes `1.0`, and `1h` followed by a space becomes `1h 0m` before the minutes are typed. Tidying is the `focusout` handler's job—`focusout` and not `blur`, because blur does not bubble and the listener is delegated on the list.

A bare number is read in the format's own unit and an explicit unit always wins, so `90` is ninety minutes under `hm` and `minutes` and ninety **hours** under `hours`. That sounds alarming until you notice that under `hours` the field is showing `1.5`, so a rider typing there means hours—and anyone who means minutes can type `90m` in any format. An unparseable value stores null rather than holding the last good number, so a typo and an empty field mean the same thing, which is what they look like they mean.

The preference is `user_profiles.duration_format`, a defaulted enum rather than a nullable column so there is no third state for every reader to interpret differently. **A rider may still have no profile row at all**, which is why `toDurationFormat()` exists and why `/settings/duration-format` upserts rather than updates. It is its own route and not part of the profile form's POST: that handler validates and rewrites the whole profile, so posting one preference through it would mean carrying every other field along and a missing one would blank an address.

The granularity cost the roadmap flagged is real and visible the moment you look at a ride: an 11-minute stop reads `0.2` and a 23-minute one reads `0.4`. That is why the other two formats exist rather than being a fallback nobody picks.

## TL;DR

routeloop is a ride **planning / sharing / organizing** app, not navigation. It is live at `routeloop.app` on a Synology NAS behind Cloudflare Tunnel.

Two migrations drove the branch `refactor/google-maps-and-auth`, which is long since merged. **Both are finished**—this table is kept as history, not as work:

|      | Was                                | Became                                      | State                                                                                                                                                                                                                                                 |
| ---- | ---------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth | Cloudflare Access                  | Google OAuth + magic link, owned by the app | **Done.** Deployed to stage and production 2026-07-30 and signing in ever since. One edge remains and it is at the Cloudflare edge, not in the repo: the Access policy is still defined and is now pure redundancy                                    |
| Maps | Mapbox GL + Directions + Geocoding | Google Maps JS + Places + Routes            | **Done.** Builder, viewer, search and geocoding all run on Google; `main.js` and every `MAPBOX_*` value are gone. Verified against the code 2026-08-02 and again 2026-08-06, because this row claimed otherwise for a day after it stopped being true |

## The site typeface is Overpass, self-hosted, 2026-08-13

**None of this is deployed.** Production still serves Archivo from Google Fonts; everything below is local and pushed no further than `main`.

The face is now **Overpass**, drawn from Highway Gothic, and it is served from `public/font/` rather than linked from Google. Four `woff2` files, one variable font per subset: upright and italic, latin and latin-ext, each declaring `font-weight: 100 900`, so every hundred is a genuine interpolated cut. The `@font-face` rules live in `style/_fonts.scss`, `@use`d from `main.scss` immediately after tokens.

Self-hosting was chosen over the CDN for three reasons that survive scrutiny: no visitor IP reaches a third party, the critical path loses a DNS lookup and a TLS handshake to `gstatic.com`, and a future CSP can name only this origin. The often-cited fourth reason—that a visitor may already hold the file cached from another site—has not been true since Chrome 86 partitioned the HTTP cache per site. Overpass is dual licensed SIL OFL 1.1 and LGPL 2.1, which is what makes redistributing it here legitimate.

Three traps are already paid for, and re-check them if any of this is touched:

- **The preload in `layout.tsx` is deliberately not wrapped in `asset()`.** It has to be byte-identical to the URL in the `@font-face` rule, and SCSS cannot emit a content hash. A `?v=` on one side only gives two URLs, a double fetch, and a console warning that a preloaded resource went unused. Version a font by renaming the file.
- **Only the upright latin subset is preloaded.** A `@font-face` is not discovered until the CSS is parsed, so without a preload the common case starts a full round trip late; preloading the other three would waste bandwidth on pages that never ask for them.
- **Overpass has no width axis.** Archivo had one and `font-stretch` worked. Here it is inert—there are no `font-stretch` declarations left, and letter-spacing is the substitute.

The weight scale came down with the swap. Every weight in `style/` dropped one step of 100 (72 lines across 12 partials), `font-weight: bold` was rewritten numerically so it lands on a real cut, and five `font:` shorthand declarations that carried a weight were caught too. Then the part the sweep could not reach: **headings and `strong`/`b` had no weight rule anywhere in the stylesheet** and were rendering at the user agent's `bold`. They are now named in `_base.scss`—`h1` at 500, `h2`–`h6` and `strong`/`b` at 600, against 300 body copy. The splash `.eyebrow` sits at 700, heavier than the `h1` above it, because 0.12em of tracking needs weight to hold as a block.

Headline tracking was loosened for the same reason the weights were. `-0.04em` on the splash `h1` and `-0.03em` on `.hero-value` had been carried across Lato, Barlow and Archivo without re-examination; Overpass sets narrower, so both closed up and are now `-0.01em`. **Tracking is face-specific and does not survive a typeface swap**—re-check those two lines whenever the face changes.

### Lint configs, the README, and a renamed remote

- **Three root config symlinks are gone.** `.markdownlint.json`, `.hadolint.yaml` and `.shellcheckrc` were absolute symlinks into `~/www/moto/tankbag/.qlty/configs/` and broke when the checkout was renamed. Qlty reads `.qlty/configs/` natively and never needed them; they existed only so editor extensions could find a root config. `.vscode/settings.json` now points markdownlint at the real path and is tracked, since `.vscode` came out of `.gitignore`. `shellcheck` and `hadolint` have no equivalent setting—neither binary is installed locally and neither extension is recommended, so nothing reads them outside `qlty check`.
- **The README carries the stacked logo**, theme-switched with `<picture>` and `prefers-color-scheme`, above the H1 behind a scoped `MD041` disable. GitHub strips every `style` attribute, so the spacing below it is `<br>` tags rather than CSS.
- **The filename-convention diagram was misaligned** and is now checked column by column against the example filename.
- **`origin` is `github.com/feralcreative/routeloop.git`.** The GitHub repo was renamed; the local remote had been riding GitHub's redirect.
- **`riders/` is gitignored** and holds a readable extract of the two non-owner accounts, pulled from a production dump. Real email addresses—never commit them.

Production, as of a read-only `db-backup` on 2026-08-13: five accounts. Three are the owner's, one outside rider is `active`, and one is `pending`. `invites` and `invite_redemptions` are both empty.

**Open, and it will bite the next person to run `docker compose up`:** the local dev database volume. Compose pins project `routeloop` and declares `routeloop-db-data`, so it wants `routeloop_routeloop-db-data`, which does not exist. The running container predates the rename and is still mounted on `tankbag_tankbag-db-data`. The moment it is recreated, the dev database comes up empty while every local row stays in the old volume. Migrate the volume, restore a dump into a fresh one, or start clean—but do it deliberately rather than by accident.

## The new brand assets are wired up, 2026-08-12

New artwork was drawn rather than recovered from `e8d5873^`, and it is **not** the old Routeloop set. Two aspect ratios moved far enough that no width or height anywhere is a nudge of the previous one—every number was re-derived from a target height:

| Lockup     | Was               | Is                       |
| ---------- | ----------------- | ------------------------ |
| Horizontal | 1595×456 (3.50:1) | 1500×184 (**8.15:1**)    |
| Stacked    | 920×648 (1.42:1)  | 920×518 (**1.78:1**)     |
| Email      | 360×103 (3.50:1)  | 800×100 @2x (**8.15:1**) |

What that forced, and what to look at first if any of it reads wrong:

- **The splash uses the stacked mark now**, where it has always used the horizontal one. At 8.15:1 the horizontal lockup renders 52px tall in the 420px the splash gave it, against the 123px it used to have, and no width this layout can spend buys that back—1000px would. The stacked mark gets there, and sits at 200px wide / 113px tall after the fit pass below.
- **The nav lockup is 28px tall**, down from 48px. Every pixel of that height is letterform now, where most of it used to be the bag icon; 48px would draw a 391px banner across the header.
- **The map badge is 64px**, down from 92px, for the same reason on two lines instead of one.
- **The email wordmark displays at 400×50**, up from 180×52, which is nearly the full 536px the cell has.
- **`-dk` is the delivered spelling** of the reversed variant on the site's four SVGs. The suffix still names the _ground_, not the ink. The two email PNGs keep `-dark`, also as delivered—`src/emails/shell.tsx` and `docs/email.md` both say so.
- **The stacked mark carries no axis suffix**: it is `logo-routeloop.svg`, not `-vt`. `_assets/logo-routeloop-vt.png` is byte-identical to `logo-routeloop-dk@2x.png` and is a mislabeled duplicate; nothing ships from it.
- **The favicon set is generated, not hand-cut.** `node utils/build-favicons.mjs` renders all eight files in `public/img/favicon/` from `source-light.svg` and `source-dark.svg` in that same folder, through `rsvg-convert`. The `.ico` is assembled in that script from PNG payloads, so the repo needs no icon encoder for it.
- **The mark inside the 1000×1000 favicon canvas is only 1000×502**, with transparent bands top and bottom. So the manifest's own icons are `purpose: "any"`, and a separate opaque `maskable-*` pair on `#ffdd00` carries the 80% safe zone Android wants. Declaring the transparent, letterboxed icon `any maskable`—which it did—crops a launcher straight into the loop.
- **`public/site.webmanifest` and the repo-root `site.webmanifest` are gone.** Neither was linked from anywhere, they disagreed with each other on name and theme color, and the root one pointed at paths that do not exist. `public/img/site.webmanifest` is the one `siteIconLinks()` serves.

Two things to know before redrawing any of it. The email PNGs are **opaque by design**—both are currently 800×100 with zero non-opaque pixels, and `test/email-dark-mode.test.ts` reads their corner pixels to keep it that way. And **`public/img/` is now the only copy the repo has**: `_assets/` was removed on 2026-08-15 as uncommitted personal artwork, so export straight into `public/img/`. A master updated only in `_assets/` ships nothing and no test will notice—the drift check that used to catch exactly that had nothing left to compare against and was deleted with it.

Still open: `_assets/github/tankbag-github-share.png` is the GitHub repo social image, uploaded through GitHub's settings UI rather than served from here, and no replacement was drawn.

### The sign-in page fits its fold again

`/login` scrolled, and the logo was not why. **`.splash` held `min-height: 100svh` while the footer sat after it inside `.page-wrap`**, so the document was one viewport _plus_ the footer—it scrolled by exactly 52px at every viewport height, and no amount of shrinking the copy could have fixed it, because a `min-height` that large just pads the slack back in. The viewport height moved up to `.page-wrap`, which is now the flex column, and `.splash` takes what the footer leaves via `flex: 1; min-height: 0`.

With that corrected the content still overran the two short tiers, so both were re-cut and a third added. `.splash` is a **flex container, so none of its children's margins collapse**—every margin in that stack is spent in full, which is why the trims are spread across padding, the eyebrow's gaps, the headline and the mark rather than taken out of the logo alone:

| Viewport height | Logo    | Headline (max) |
| --------------- | ------- | -------------- |
| Base            | 200×113 | 4.5rem         |
| ≤760px          | 128×72  | 3rem           |
| ≤700px          | 112×63  | 2.5rem         |
| ≤600px          | 88×50   | 2.5rem         |

The `≤700px` tier was keyed on `620px` before this: the tier above it ran out of budget around 700, so anything between 621 and 700 scrolled with neither tier trimming it. **537px is the measured floor**—below that the page scrolls, and it should. `.providers` is 152px of email field, Google button and note and `.splash-gate` another 94px, and trimming either further means taking away something a visitor came to use.

## Renamed back to routeloop, 2026-08-11

The third flip. `routeloop.app` is canonical, `tankbag.app` 301s to it. Entries below this line that say "tankbag" are history and are left as written.

**What made this one cheap:** none of the routeloop infrastructure was ever torn down. Both hostname pairs still have live tunnel routes, the container has been publishing both host ports the whole time, and the Cloudflare Access applications were still named "Routeloop Login". Each hostname reaches the same port it always has—`routeloop.app` on `:16703`, `tankbag.app` on `:6686`—so `deploy.config` swaps which one is canonical and nothing at Cloudflare moves. **`src/db/schema.ts` contains no brand string at all, so there is no migration and no backfill.**

**The two file-format contracts are write-new, read-both, permanently:**

- **The filename marker.** `buildExportName` writes `routeloop_`; `parseExportName` accepts `routeloop` and `tankbag` via `READ_MARKERS`, and `COMPOUND_EXTS` carries both `.routeloop.json` and `.tankbag.json`. Mirrored in `public/js/filename.js`, with the legacy names in the shared fixture list so the two implementations cannot drift apart on the compatibility rule either.
- **Native JSON went to format version 3**, which renamed the envelope's version key from `tankbag` to `routeloop`. `nativeVersion()` reads whichever key is present and `isNativeRide` accepts either. `upgradeNativeRide` needed no new arm—v3 changed the envelope, not the ride payload—but note a v1 file necessarily carries the old key, so the oldest upgrade path is now only reachable through it.

Dropping either would have failed **silently**: the files still import, just stripped of day order and dates, which is exactly the information a filename exists to carry because GPX and KML cannot. `test/filename.test.ts` and `test/native.test.ts` both have explicit legacy blocks, because a mass find-and-replace through those fixtures goes green while breaking every file a rider holds.

`GET /api/public/maps/:slug/tankbag.json` stays registered alongside the routeloop path—the ride page linked it, so it is in bookmarks. Both sit ahead of the generic `:format` route, same as the zip route and for the same reason.

**Cookies were renamed with no legacy read**, deliberately: they are host-scoped with no `domain` attribute, so moving the canonical host invalidates them regardless. Everyone signs in once and the alpha splash reappears once. `routeloop_session`, `routeloop_oauth_state`, `routeloop_oauth_verifier`, `routeloop_invite`, and the two `routeloop.*` localStorage keys.

**Corrected while passing through:** `deploy.config` claimed Compose derives its project name from the deploy directory. That stopped being true when `deploy.sh` started pinning `COMPOSE_PROJECT_NAME`—the volume follows `$PROJECT_NAME`, so anyone following the old comment would migrate the wrong thing. The `$accent` comment in `_tokens.scss` was also inverted: the yellow _was_ lifted from the Routeloop wordmark's dashed center line, and now matches the mark again.

**Not done, and not scriptable from the repo:**

1. ~~**The Maps browser key referrer list** still carries only the tankbag hosts. It must gain the routeloop ones _before_ the flip or the key is blocked on its own site—`RefererNotAllowedMapError`, a map that never draws while the rest of the page looks fine.~~ **Done—and superseded 2026-08-16**, when the list was consolidated to five wildcard patterns covering rollchart, routeloop and tankbag plus the two local origins. See "Console work completed 2026-07-27" below for the current command and for the apex-domain check that consolidation still needs. The OAuth redirect URIs are a separate list and are **not** covered by that change.
2. **`CLOUDFLARE_ZONE_ID`** in `.env` still points at the tankbag.app zone. The purge failure is non-fatal, so a wrong zone means stale assets behind a green deploy.
3. **The infrastructure rename needs a data migration.** `PROJECT_NAME`, the container/image/network names and the Postgres role and database all move to `routeloop`. The deploy directory follows `$DOMAIN` and carries the bind-mounted `data/storage` with it; the named volume follows `$PROJECT_NAME` and does not follow a `mv`. Back up first, bring the old stack down from the old directory by hand (the deploy's own `down` runs in the new one and cannot see it), and do not trust the deploy's verification—the origin curl is a warning only and the container check passes against an empty database.
4. **GCP console object names are left alone**, following the precedent set at the last rename. The project cannot be renamed in place and the keys are identified by uid.

## The naming is settled: ride > day > leg, 2026-08-09

**`routes` is now `days`.** The hierarchy is **ride > day > leg > stop/POI**, and those are the only four words for them. Everything below this line in this document predates the rename and is left as written—where an older entry says "route" for what is now a day, the entry is history, not instruction.

Why it moved: every rider-facing surface already said "day"—the builder slider, the viewer legend, `DAY_COLORS`, the `dNN` filename field, the `#one-file-per-day` FAQ anchor—while the table said `routes`. Meanwhile "route" was doing two other jobs in the same files: the import page's word for a whole ride, and the ~130 `adminRoutes` / `app.route()` / `src/routes/` identifiers that mean HTTP handlers. The clearest single symptom was `viewer.js`: `const day = ... state.ride.routes[active.dayIndex]`—a variable called `day`, indexed by `dayIndex`, reading an array called `routes`.

Rejected alternatives, both considered and dropped: **"trip"** for the top level (it appears in older copy, but renaming `rides` buys nothing a rider ever sees) and **"leg"** for the middle level (it would have evicted `route_legs` from its own accurate name).

What changed:

- **Schema**—`routes` → `days`; `points.route_id` and `route_legs.route_id` → `day_id`; four indexes and three constraints renamed to match. Migration in [utils/deploy/sql/2026-08-09-routes-to-days.sql](../utils/deploy/sql/2026-08-09-routes-to-days.sql), applied to dev. **Every statement is a catalog rename**—no table rewrite, no rows touched, safe against a populated stage or prod.
- **`route_legs` deliberately keeps its name.** The "route" in it is the path a day traces, which is what those legs compose, not a reference to the renamed table. Only the foreign key moved.
- **Three wire formats** renamed their `routes` key to `days`: the viewer's `ride.json`, the builder's load/save, and native Tankbag JSON.
- **Native JSON went to format version 2.** Version 1 files still import—`upgradeNativeRide()` in `src/maps/export.ts` maps the old key. That is done there rather than by teaching `ridePayload` to accept either key, because the same schema validates live builder saves, and a builder that can still post `routes` is a second name kept alive by accident.
- **`MAX_ROUTES` → `MAX_DAYS`**, `ExportRoute` → `ExportDay`, `RouteRow` → `DayRow`, and the `route*` day helpers in `ride-time.js` / `twist.js` → `day*`. `tripSpan` → `rideSpan`.

**Deliberately not renamed**, because "route" there means a path or an outside-world file, not a day: `map-common.js`'s layer functions (`addRouteLayers`, `setRouteVisible`, `setRouteDim`), `POST /api/route`, the `route-*` CSS classes, `src/routes/*` and every `*Routes` handler, and the import page's "Import a route" / "Route files" copy, which is doing the conversion from a rider's vocabulary to ours.

**Verified:** typecheck clean, 765 tests passing, and in Chrome with zero console messages—the viewer renders, the builder loads all three days of a multi-day ride with per-day colors, a save round-trips losslessly (3 days / 19 points / 12 legs before and after), and forged v1 and current v2 native files both import to identical row counts.

**One bug this caught, which nothing else would have.** `GET /api/rides/:id` built its payload as a loosely-typed `out` object, so its `routes:` key was invisible to the compiler. The suite passed and the builder silently loaded zero days—a blank Day 1 over an empty map. Renaming a key that crosses the wire needs a browser, not a green suite.

## Renamed back to tankbag, 2026-07-29

The `routeloop` name lasted five days. `tankbag.app` is canonical again, `routeloop.app` 301s to it, and the reasoning is that a tank bag is the thing with the map pocket on top—the pre-GPS object that held your route. The known cost is SEO: "tank bag" is a generic luggage category, so the name competes with Nelson-Rigg and Givi for its own search results.

Done in the repo: the canonical/legacy host map reversed, cookies (`tankbag_session`, `tankbag_oauth_state`, `tankbag_oauth_verifier`), the alpha-splash localStorage key, Postgres role and database, container/image/network names, deploy config, page titles, magic-link email copy, and eight new logo files replacing the old set. Typecheck and the SCSS build both pass.

**Not done, and none of it is scriptable from the repo:**

1. ~~**Browser Maps key referrers.**~~ **Done 2026-07-29**—the allow-list now carries the tankbag hosts alongside the routeloop ones, verified per origin. See "Console work" below.
2. ~~**OAuth client.**~~ **Done 2026-07-30**—created on the tankbag GCP project with an External consent screen and the three tankbag redirect URIs. See "Google Cloud migrated to the tankbag project" below.
3. ~~**Favicons.**~~ **Done 2026-07-31**—regenerated from the current mark and moved into `public/img/favicon/` in `22610b8`. This entry described them as stale, at paths that no longer existed, for longer than it was true; an issue got filed off it on 2026-08-01 for work already finished. If a checklist item here is about assets, look at the files before believing it.
4. ~~**The repo directory** is still `/Users/ziad/www/moto/routeloop`.~~ **Renamed 2026-07-30** to `/Users/ziad/www/moto/tankbag`. **And renamed back since**—as of 2026-08-16 the checkout is `/Users/ziad/www/moto/routeloop` again, so this entry is history in both directions. Two `cd` paths in this document still said `tankbag` on that date and were corrected; older `_PLANS/` files and shell history were left alone.
5. ~~**SonarCloud project key** in `.vscode/settings.json`.~~ **Moot as of 2026-08-03—SonarCloud is retired.** It was too noisy to be useful: 258 open findings, of which 86 were shell style in the deploy scripts and 31 were optional-chaining nudges, against 16 real bugs and vulnerabilities. Replaced by [Qlty](https://qlty.sh), run locally from the CLI, on the theory that a small tuned rule set that people read beats a large one they learn to ignore. The GitHub repo _was_ renamed on 2026-07-30—it is `feralcreative/tankbag` now, and the local remote was re-pointed at it the same day. The old `feralcreative/tankbag-app` URL still works only through GitHub's rename redirect, so anything still hardcoding it is living on borrowed time.
6. **`_PLANS/` history was left untouched.** `chat-with-sol.md` in particular is a transcript of the _previous_ rename; rewriting it would turn a record of what happened into fiction.

## Phase 0—settled, 2026-07-27

The maps migration was gated on one unproven assumption: that Google's place search is meaningfully better than Mapbox Geocoding on real queries. A standalone Google map plus a `PlaceAutocompleteElement` was built and driven against live queries.

**Verdict: Google is decisively better. The gate is passed and the migration is on.** The scratch page was throwaway by design and is not in the repo.

Two things fell out of building it that outlive the page itself, both recorded in [\_PLANS/AMENDMENTS-google-auth-and-maps.md](../_PLANS/AMENDMENTS-google-auth-and-maps.md): the `TWO_WHEELER` trap below, and the discovery that `GMAPS_KEY` had no restrictions at all.

## The `TWO_WHEELER` trap—read before touching routing

The plan file recommends `travelMode: "TWO_WHEELER"` for a motorcycle app. **It does not work in the United States.** It is served only in some South and Southeast Asian markets, and elsewhere the Routes API answers **HTTP 200 with an empty body**—no route, no error. Following the plan would have made every leg fail as "no road route" with nothing to diagnose.

```text
Barstow -> Victorville, CA        Jakarta, Indonesia
  DRIVE        71316 m              TWO_WHEELER  13324 m
  TWO_WHEELER  {}
  BICYCLE      76088 m
```

`DRIVE` is what [src/routes/routing.ts](../src/routes/routing.ts) uses, with the reasoning in a comment so it does not get helpfully "corrected" later.

<!--| PAGE-BREAK -->

## Done and committed

**Through `2a96dae`:** the pivot from file-upload to in-app planning (Phases 0–2), the `tankbag` → `routeloop` rename with production cutover (since reverted—see below), the unified page shell and SCSS partial split, the sign-in splash, and Sprint 2's user profiles.

**`17de208`—auth replacement.** Cloudflare Access is gone from the codebase: `src/auth/access.ts` deleted along with the `Cf-Access-Authenticated-User-Email` trust and the `DEV_AUTH_EMAIL` fallback. New modules are [identity.ts](../src/auth/identity.ts) (provider-agnostic `resolveUser`), [google.ts](../src/auth/google.ts) (Arctic OAuth, state + PKCE, rejects unverified emails), [magic.ts](../src/auth/magic.ts) (hash-only storage, single-use, 15-minute expiry, rate limited) and [mailer.ts](../src/auth/mailer.ts). Both methods are feature-flagged by omission—with no credentials the controls are not rendered rather than offered and broken.

Note this corrects the previous handoff, which described the auth work as uncommitted. It is committed; the tree is clean.

**`942e1d9`—the map engine port.** Mapbox GL out, `google.maps` in, across `map-common.js`, `viewer.js`, `builder.js`, both page shells and the marker CSS. Detailed below.

**`728fd0b`—role picker.** A pre-existing CSS bug the port surfaced: `.builder-panel .point-list .row-roles { display: grid }` outranks the UA's `[hidden] { display: none }`, so every stop rendered its category picker permanently open, all 17 roles. The markup had always set the attribute; only the CSS ignored it.

**`8b39424`—splash clip at half speed.** Re-encoded from the ProRes master in `_assets/`, not from the published mp4—lossy-to-lossy compounds artifacts. The slowdown is baked into the file with **interpolated** intermediate frames, because `playbackRate = 0.5` on a 25fps source shows 12.5fps and reads as choppy; the browser holds each frame longer rather than generating new ones. 1280×720, 25fps, 21.96s, 3.0 MB.

```bash
ffmpeg -i _assets/video/routeloop-intro.mov \
  -filter:v "scale=1280:720:flags=lanczos,setpts=2*PTS,minterpolate=fps=25:mi_mode=mci:mc_mode=aobmc:vsbmc=1,format=yuv420p" \
  -an -c:v libx264 -crf 33 -preset slow -movflags +faststart public/video/tankbag-intro.mp4
```

Scale before interpolating—interpolating at 4K first is dramatically slower for no visible gain.

## The engine port—done 2026-07-30

The Mapbox engine is gone from the rendering path. `map-common.js` was rewritten against `google.maps`, and both consumers moved with it in the same commit, because a half-ported engine renders nothing.

**The shape of the change.** `map-common.js` is now the only file that touches `google.maps`. The Mapbox version left marker construction to its callers, so `viewer.js` and `builder.js` each reached for `new mapboxgl.Marker` directly—which is exactly why swapping engines touched three files instead of one. They now go through `addMarker` / `removeMarker` / `onMarkerDragEnd` / `searchPlaces` and name no vendor API at all. Keep it that way.

What went where:

| Mapbox                                 | Google                                                                        |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `mapboxgl.Map` + `NavigationControl`   | `Maps.Map` with `mapId`, `zoomControl` bottom-right                           |
| `LngLatBounds` + `fitBounds(maxZoom)`  | `LatLngBounds`; **no** maxZoom option, so a one-off `idle` listener clamps it |
| `addSource` / `addLayer` line + symbol | one `Polyline` per route, held in a `WeakMap` keyed by map                    |
| `ensureArrowImage` (canvas triangle)   | **deleted**—`Polyline.icons` + `FORWARD_CLOSED_ARROW`                         |
| `mapboxgl.Marker({element})`           | `AdvancedMarkerElement({content})`                                            |
| `mapboxgl.Popup`                       | `InfoWindow` with `headerDisabled`                                            |
| Geocoding v6 forward                   | Places `AutocompleteSuggestion` + session tokens                              |
| `map.on('load')`                       | nothing—the map is usable when the constructor resolves                       |

**Three things worth knowing before you touch it again:**

- **`.tb-marker` is deliberately `0×0`** ([style/\_map.scss](../style/_map.scss)). An `AdvancedMarkerElement` anchors its content at the content's _bottom-center_; a zero-size box puts that anchor exactly on the point, so the legacy negative-margin offsets keep working. Size that wrapper to its contents and every marker drifts up and to the right of its own coordinates.
- **Coordinate order stays confined to `toLatLng` / `fromLatLng`.** Same discipline as `toGoogleWaypoint` in [routing.ts](../src/routes/routing.ts). Verified live: a leg round-trips as `[-117.022799, 34.895831]`, lng first.
- **Search had to move too.** It was not scope creep: each provider's terms tie their search results to their own basemap, so Mapbox Geocoding drawn on a Google map breaks Mapbox's terms just as Places on a Mapbox map breaks Google's.

Verified in a browser with zero console messages on both pages: Places autocomplete returns split main/secondary text, picking a result adds a named stop, a second stop routes through `/api/route` and draws real road geometry with arrows, save round-trips, and the viewer renders markers, mileage tooltips, the visibility checkbox, hover-dim and the arrow toggle.

**`POST /api/route`**—[src/routes/routing.ts](../src/routes/routing.ts), registered in [src/index.tsx](../src/index.tsx). Server-side proxy to the Routes API, gated by `requireAuthApi` + `requireActiveApi` + `requireSameOrigin`. It exists because the Routes key is IP-restricted and so cannot be used from a browser. It carries a bounded in-process cache of computed legs, which matters because a rider dragging a stop re-requests the same pair constantly and Routes bills per call. The builder calls it now.

Verified end to end against the live API:

| Case                                                   | Result                                                         |
| ------------------------------------------------------ | -------------------------------------------------------------- |
| Barstow → Victorville                                  | 71,316 m / 3,059 s / 218 points—identical to a direct API call |
| Two via points                                         | 200                                                            |
| No session                                             | 401                                                            |
| Foreign `Origin`                                       | 403                                                            |
| Malformed body                                         | 400                                                            |
| Coordinates passed as `[lat, lng]`                     | 400—caught by range validation, not silently routed            |
| Unroutable pair (mid-Pacific)                          | 422                                                            |
| Server key present in `/`, `/builder`, `/login` source | 0 occurrences                                                  |
| Cache                                                  | 256 ms cold, 5 ms warm                                         |

**`.env`** gained `GMAPS_SERVER_KEY` and a placeholder `GMAPS_MAP_ID`, and lost a comment that falsely claimed `GMAPS_KEY` was referrer-restricted. A timestamped `.env.bak-*` sits beside it.

**`.gitignore`** gained `.env.bak*` and `.env.backup*`. This was a live exposure, not housekeeping: the existing patterns are `.env`, `.env.local` and `.env.*.local`, none of which match a `.env.bak-<timestamp>` suffix, so the backup—holding both real API keys—was showing as an untracked file that `git add -A` would have committed. Delete the backup once you are satisfied with the `.env` edits.

## Console work completed 2026-07-27

Names in this section are **live Google Cloud console values and are deliberately not renamed**. The rename back to tankbag changed this repo only; nothing in the console moved, and a console object called `routeloop` is still called `routeloop`.

The project behind the Maps keys is **`routeloop-503503`** (display name `routeloop`). This was not written down anywhere before and is easy to get wrong—there are four plausible projects (`tankbag`, `routeloop-app-stage`, `feralcreative-routeloop-prod` all exist and none of them owns the key).

- **All required APIs were already enabled**—Maps JavaScript, Places (New), Routes, Geocoding. The old checklist item to enable five APIs was stale.
- **Server key created** → `GMAPS_SERVER_KEY`. Display name "routeloop server (Routes + Geocoding, IP-restricted)", uid `a321c95b-05e3-4f11-82db-25baa39a9c55`. Restricted to IP `69.209.26.137` and to Routes + Geocoding only. Verified working for both. IP-restricted, so the domain rename does not affect it.
- **Browser key locked down** → uid `010d908a-9158-4169-b5cb-98d8f08f6b16`. It previously had **no** referrer restriction and was authorized for 35 APIs. It now allows only `routeloop.app`, `www.routeloop.app`, `stage.routeloop.app`, `127.0.0.1:6686` and `localhost:6686`, and only Maps JavaScript + Places. Verified per origin, including that propagation actually landed—`evil.example.com` went from ALLOWED to BLOCKED—and confirmed in a real browser that tiles and Places still work.

  **Updated for the rename, 2026-07-29.** The list now also carries `tankbag.app`, `www.tankbag.app` and `stage.tankbag.app`, verified per origin. The routeloop entries were kept deliberately until the 301s are retired, because the redirect only fires after the page's own scripts have already loaded on whichever host was requested. Left undone, the browser key would have been **blocked on its own site**—Maps and Places failing with `RefererNotAllowedMapError` while everything else worked.

  The command, for when the list changes again. Note that mutating an API key trips Workspace reauthentication: gcloud prompts in-terminal for the active account's password rather than opening a browser, which is easy to mistake for an ssh or sudo prompt.

  **Corrected 2026-08-02**—this command named the retired `routeloop-503503` project and its browser-key uid, so running it as written would have edited a key nothing uses. The live pair is the `tankbag` project and uid `53e9a638`:

  ```bash
  gcloud services api-keys update 53e9a638-bafb-4604-9346-282dd8c25d80 \
    --project=tankbag \
    --allowed-referrers="https://tankbag.app/*,https://www.tankbag.app/*,https://stage.tankbag.app/*,https://routeloop.app/*,https://www.routeloop.app/*,https://stage.routeloop.app/*,http://127.0.0.1:6686/*,http://localhost:6686/*"
  ```

  **Consolidated 2026-08-16.** Ten explicit hosts became five patterns, with subdomain wildcards replacing the per-host entries:

  ```bash
  gcloud services api-keys update 53e9a638-bafb-4604-9346-282dd8c25d80 \
    --project=tankbag \
    --allowed-referrers="https://*.rollchart.app/*,https://*.routeloop.app/*,https://*.tankbag.app/*,http://127.0.0.1:6686/*,http://localhost:6686/*"
  ```

  Two things this changed that are worth knowing before the next person reads the list.

  **`rollchart.app` is on this key now.** It was not in any earlier version of the allow-list and is not mentioned anywhere else in this document. The browser key is therefore shared with a second app, so its quota, its billing and any future lockdown are no longer a routeloop-only concern.

  **`https://*.domain/*` does NOT cover the bare apex, and this consolidation is an outage waiting to land.** Established 2026-08-16 after a first round of testing reached the opposite conclusion and was wrong.

  **Google documents the answer plainly.** [Adding restrictions to API keys](https://docs.cloud.google.com/api-keys/docs/add-restrictions-api-keys) says allowing a whole site takes **two** entries, not one: "URL for the domain, without a subdomain, and with a wildcard for the path. For example: `example.com/*`" **and** "A second URL that includes a wildcard for the subdomain and a wildcard for the path. For example: `*.example.com/*`". Note both examples are written **without a scheme**—which matters, because the console refuses `https://rollchart.app/*` as a duplicate of `https://*.rollchart.app/*` while the documented scheme-less pair is the configuration Google prescribes.

  **How the first test round produced a false pass.** These four lines were read as proof the wildcard covered the apex:

  ```text
  https://evil.example.com/        BLOCKED
  https://routeloop.app/           ALLOWED
  https://www.routeloop.app/       ALLOWED
  https://tankbag.app/             ALLOWED
  http://localhost:6686/           ALLOWED
  ```

  Every one of those hosts was an explicit entry in the **pre-consolidation** list, so the run is equally consistent with the old rules still being served—and the discriminating run showed exactly that:

  ```text
  https://evil.example.com/          BLOCKED
  https://anything.routeloop.app/    BLOCKED   <- must be ALLOWED under *.routeloop.app/*
  https://www.rollchart.app/         BLOCKED   <- must be ALLOWED under *.rollchart.app/*
  https://routeloop.app/             ALLOWED   <- only the OLD explicit entry grants this
  ```

  The wildcards are not being enforced yet. **When they are, the apex loses its explicit grant and goes dark**—`RefererNotAllowedMapError` on the primary domain, which this section already records happening twice.

  **The lesson is about the control, not the wildcard.** `evil.example.com` proves *a* restriction is live; it can never prove *which* list is live, because it was absent from every version. Only a host the new rules allow and the old ones did not can do that—`https://anything.routeloop.app/`. A verification run that omits such a host cannot distinguish "the change worked" from "the change has not landed", and on 2026-08-16 that gap produced a confidently wrong all-clear.

  **Fixed and verified 2026-08-16.** The list is now Google's two-entry recipe per domain, scheme-less, plus the two local origins:

  ```bash
  gcloud services api-keys update 53e9a638-bafb-4604-9346-282dd8c25d80 \
    --project=tankbag \
    --allowed-referrers="rollchart.app/*,*.rollchart.app/*,routeloop.app/*,*.routeloop.app/*,tankbag.app/*,*.tankbag.app/*,http://127.0.0.1:6686/*,http://localhost:6686/*"
  ```

  ```text
  https://evil.example.com/          BLOCKED
  https://anything.routeloop.app/    ALLOWED   <- was BLOCKED minutes earlier; dates the list as current
  https://www.rollchart.app/         ALLOWED
  https://routeloop.app/             ALLOWED
  https://www.routeloop.app/         ALLOWED
  https://tankbag.app/               ALLOWED
  https://stage.tankbag.app/         ALLOWED
  http://localhost:6686/             ALLOWED
  ```

  The `anything.routeloop.app` line is what makes this run conclusive where the earlier one was not: it was BLOCKED under the old list and ALLOWED under this one, so it proves *which* configuration answered.

  **The scheme-less form costs plaintext coverage, and here is the measured size of it:**

  ```text
  http://routeloop.app/              ALLOWED
  http://www.tankbag.app/            ALLOWED
  ```

  Every production host now accepts an `http://` referrer. That is inherent to the documented recipe—the console will not accept a scheme-qualified apex beside a scheme-qualified wildcard, so there is no way to get apex coverage *and* keep the entries HTTPS-only. It is worth knowing rather than worth fixing: a `Referer` header is trivially forged outside a browser, so this restriction is a deterrent against casual key reuse rather than access control, and the app itself is HTTPS-only regardless. If it ever needs tightening, the lever is a scheme check somewhere real, not this list.

**The NAS and the workstation share one egress IP, `69.209.26.137`.** They are on the same residential line. That is convenient now and is exactly the fragility to watch: an ISP lease change silently breaks server-side Routes and Geocoding while the browser key keeps working, so it presents as a routing bug rather than a credentials one.

### Re-verifying the keys

Run this when routing starts failing for no visible reason, or after any change in the Cloud console. It is the same check used when the restrictions were applied. The first line must report BLOCKED—if it reports ALLOWED, the key is open again.

Both domains are listed on purpose and both must now report ALLOWED—confirmed 2026-07-29 after the allow-list was updated. `evil.example.com` must report BLOCKED in every case.

**Every run needs a host that only the CURRENT list allows, or it cannot tell "verified" from "not yet propagated".** `evil.example.com` is a control for "is any restriction live", nothing more—it has been absent from every version of the list, so it reports BLOCKED whichever one is being served. On 2026-08-16 a run built only from long-standing hosts returned all-ALLOWED and was read as a clean bill of health for a change that had not taken effect at all. Add `https://anything.routeloop.app/`: it is BLOCKED under the old explicit list and ALLOWED only under the wildcards, so it dates the configuration being measured.

**List each domain as apex and `www` both.** Google's documentation is explicit that `*.domain/*` does not cover the naked apex and that a whole site needs two entries, so `www.routeloop.app` ALLOWED beside `routeloop.app` BLOCKED is a live failure mode rather than a hypothetical—see the console-work section above.

The path in the `cd` above was stale until 2026-08-16; it pointed at the pre-rename `tankbag` checkout, so anyone copy-pasting this block failed on line one.

```bash
cd /Users/ziad/www/moto/routeloop
KEY=$(grep -E '^GMAPS_KEY=' .env | cut -d= -f2-)
for ref in "https://evil.example.com/" "https://tankbag.app/" "https://www.tankbag.app/" "https://routeloop.app/" "https://www.routeloop.app/" "http://localhost:6686/"; do
  printf '%-30s ' "$ref"
  curl -s -X POST "https://places.googleapis.com/v1/places:autocomplete" \
    -H "Content-Type: application/json" -H "X-Goog-Api-Key: $KEY" -H "Referer: $ref" \
    -d '{"input":"chevron barstow"}' | grep -q suggestions && echo ALLOWED || echo BLOCKED
done

# Has the egress IP drifted away from what the server key allows?
curl -s https://ifconfig.me; echo
ssh -p 33725 ziad@nas.feralcreative.co 'curl -s https://ifconfig.me'; echo
gcloud services api-keys describe 3a3d4f70-1838-45f7-86bf-18023c32592e \
  --project=tankbag --format='value(restrictions.serverKeyRestrictions.allowedIps)'
```

Note the shell quoting hazard that produced a false result the first time this was run: building the `-H "Referer: …"` argument conditionally through a variable expansion mangles the header, and every origin then reports BLOCKED—which reads as "the restriction works" when in fact nothing was sent. Pass the header literally, as above.

**When every origin reports BLOCKED, read the response body before believing the allow-list is correct.** On 2026-07-30 the browser key rejected _every_ referrer including `tankbag.app`, which this document had recorded as verified hours earlier. That looks exactly like the quoting hazard above, and it was not—the body said `API_KEY_HTTP_REFERRER_BLOCKED` against `projects/976935115789`, so the restriction really had been lost between the project migration and the next test. Re-applying the allow-list fixed it. `grep -q suggestions` cannot tell "blocked" from "malformed request"; the body can:

```bash
curl -s -X POST "https://places.googleapis.com/v1/places:autocomplete" \
  -H "Content-Type: application/json" -H "X-Goog-Api-Key: $KEY" \
  -H "Referer: https://tankbag.app/" -d '{"input":"chevron barstow"}'
```

The browser-side symptom is `RefererNotAllowedMapError` in the console and a map that never draws.

<!--| PAGE-BREAK -->

## Google Cloud migrated to the tankbag project—2026-07-30

The Maps keys and OAuth client used to live on `routeloop-503503` (display name `routeloop`). They now live on the pre-existing **`tankbag` project (number `976935115789`)**, so the console name matches the product again. What was done, all verified:

- **Enabled five APIs** on `tankbag` (it had none of them): Maps JavaScript, Places (New), Routes, Geocoding, Map Management.
- **Browser key** → `GMAPS_KEY`. uid `53e9a638-bafb-4604-9346-282dd8c25d80`. Referrer-restricted to the tankbag + routeloop hosts and both dev origins (`127.0.0.1:6686`, `localhost:6686`), and to Maps JavaScript + Places only. Verified: `evil.example.com` BLOCKED, real hosts ALLOWED.
- **Server key** → `GMAPS_SERVER_KEY`. uid `3a3d4f70-1838-45f7-86bf-18023c32592e`. IP-restricted to `69.209.26.137`, Routes + Geocoding only. Verified against a live Routes call.
- **Vector Map ID** → `GMAPS_MAP_ID` = `a8979f770ff370036c0c516d`. Type **JavaScript / Vector**, with **tilt and rotation enabled** deliberately—riders want to see terrain relief; the map still opens flat and north-up, the 3D camera is opt-in via gesture.
- **OAuth client + External consent screen** → `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, scopes exactly `openid email profile`. Redirect URIs are the three tankbag hosts below. Verified: `/auth/google` 302s to Google with the right client, scope and PKCE.
- **Gmail app password** → `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` (`tankbag.app@gmail.com`). Verified with `transporter.verify()`.

**The old `routeloop-503503` keys are now orphaned but must stay alive** until the new `.env` is deployed to prod—the _live_ prod build still uses them. Delete them only after the prod cutover, or the imported-ride viewer breaks in production.

Both the referrer-update command and the re-verify block now name the `tankbag` project and the live key uids, corrected 2026-08-02.

## Console hardening—done 2026-08-02

The credential items (Map ID, OAuth client, SMTP) landed 2026-07-30. Everything else that was listed here is now done too, and both items this section used to carry were **already stale when they were read**—the same rot that let issue #6 sit with seven unchecked boxes when five were finished.

### Daily quota caps, applied

Overrides on the `tankbag` project (`976935115789`), verified as overrides rather than defaults:

| metric                                      | daily cap | previously |
| ------------------------------------------- | --------- | ---------- |
| `maps-backend/billable_default` (map loads) | 500       | unlimited  |
| `routes/compute_routes_requests`            | 500       | unlimited  |
| `places/AutocompletePlacesRequest`          | 500       | 175,000    |
| `places/GetPlaceRequest`                    | 300       | 125,000    |
| `geocoding-backend/billable_default`        | 100       | unlimited  |

Five metrics, not four APIs: Places bills autocomplete and place-details separately and the builder calls both—autocomplete per keystroke burst, details once per stop actually picked.

The values sit above the ~330/day free-tier break-even deliberately. Dev traffic hits this same project, so a cap that stops a runaway but also stops you working is the wrong trade.

**Two things that will bite whoever changes these next.** `gcloud alpha services quota update` **requires `--force`**: Google refuses any decrease over 10%, and "unlimited" reports as `-1`, so every cap here trips that guard and fails with `COMMON_QUOTA_UNSAFE_OVERRIDE`. And the unit must be quoted—`--unit='1/d/{project}'`—or zsh eats the braces. The first attempt at this failed both ways and the output scrolled past unread.

```bash
gcloud alpha services quota update --consumer=projects/976935115789 \
  --service=routes.googleapis.com \
  --metric=routes.googleapis.com/compute_routes_requests \
  --unit='1/d/{project}' --value=500 --force
```

### 23 of 27 Maps APIs disabled

The project had **27** Maps-family APIs enabled; the app uses **four**. Street View, Solar, Pollen, Air Quality, Aerial View, the Android/iOS SDKs, legacy Directions and Distance Matrix, legacy Places, Elevation, Roads, Time Zone and the rest are all off. What remains is exactly what the two keys target: Maps JavaScript, Places (New), Routes, Geocoding.

This is defense in depth rather than a live hole—both keys are API-restricted, so none of the 23 was reachable. It matters because **the browser key's referrer restriction was silently lost once already** during the project migration (see the `API_KEY_HTTP_REFERRER_BLOCKED` note above). Disabling shrinks what a repeat would expose.

`mapsplatformdatasets` was the one genuinely in doubt, since it looked like it might back the Vector Map ID. It does not: after disabling, the vector map still renders with `a8979f770ff370036c0c516d`, Places returns suggestions, Routes returns geometry and Geocoding resolves. All four verified in a browser against the running app.

### Privacy policy and terms

**Done**—`/privacy` and `/terms` shipped 2026-08-01. This section listed them as missing for a day after they existed. They were the blocker on publishing the External consent screen past its 100-user testing cap, so that gate is open whenever you want it.

**Sign-in now works locally**—both Google and magic link are wired and verified. The direct-session mint below is still handy for scripting an authenticated request without a browser round-trip:

```bash
# from the repo root, with the dev DB up
npx tsx -e "import('./src/auth/session').then(async m => console.log(await m.createSession(1)))"
# then send it as: Cookie: tankbag_session=<token>
```

<!--| PAGE-BREAK -->

## Ride timeline—done, 2026-08-01

Branch `feat/trip-timeline-slider`, ten commits, covering [issue #7](https://github.com/feralcreative/tankbag/issues/7) (ROADMAP item 2) and [issue #19](https://github.com/feralcreative/tankbag/issues/19), which is folded in because it is the same widget. The full plan is in `_PLANS/issue-7-trip-timeline.md`—local only, since `_PLANS` is gitignored as of `7d0db74`.

**Most of the time model was already built.** `routes.start_at` / `end_at` exist, [builder.ts](../src/routes/builder.ts) already validates, persists and returns them (it was `rides.ts` when this was written; renamed in [#104](https://github.com/feralcreative/routeloop/pull/104)), and builder state already carried them through `newRoute()`, `payload()` and `loadExisting()`. Nothing wrote them. So the first commit's worth of work was UI on a finished pipe, not plumbing.

**Four decisions, settled with the owner and worth not relitigating:**

1. **`routes.duration_s` stays riding-only.** It is already cached on saved rows and read in two places that expect that meaning. The end time is derived as start + riding + stop dwell at the point of use instead. Note the two columns already disagreed before this work: `rideTotals` counts dwell in the ride-level total, `routes.duration_s` does not.
2. **A new day seeds its start at 08:00 the following morning**, not at the previous day's end instant—which would put day 2 starting at 6pm in a hotel lobby.
3. **Times take the builder's own timezone.** `datetime-local` carries none, so a ride planned in California reads back in California time even for its Nevada legs. A per-ride timezone is the real fix and is deliberately a separate issue.
4. **The timeline does not replace the day slider.** Both write one shared focus model. The day slider also decides where new stops land, and removing it would moot #19.

**`b1e9188`—unrouted legs no longer count as zero time.** `straightLeg` still stores `durationS: 0`, because fabricating a number there would persist as though the router had returned it. Instead a leg with zero duration and non-zero distance is treated as unrouted and estimated from distance at 20 m/s (the figure `utils/seed-demo-rides.ts` already uses). That derivation survives a save/reload with no schema change, where a client-side flag would not—zod strips unknown keys, so an extra field on a leg is silently dropped on save. Anything built on it is labeled: totals prefix the riding figure with `~`.

**`2732526`—the date-time UI.** Start and end fields per day. The end fills itself from the day and keeps up as legs and stop durations change; typing one overrides it; clearing it hands control back. A note says which of those is in play.

**The bug that shaped it, because the design reads wrong otherwise.** Manual-ness was first inferred by comparing the stored end against the derived one, with no flag—which fails the moment the day changes, since an end that _was_ automatic no longer matches the new derivation and freezes as though it had been typed. The comparison is only sound at load time, when nothing has changed yet. So `inferEndManual()` runs once on load and seeds a session-only `endManual` flag that is tracked directly from then on. It is not in `payload()` and needs no column.

**Verified:** typecheck, SCSS build, and 18 assertions over the time logic, extracted from the real `builder.js` source rather than a retyped copy. That harness lives in a scratchpad, not the repo—it works by string-extracting functions, which is fine as a scratch check and a bad thing to enshrine while [#21](https://github.com/feralcreative/tankbag/issues/21) is open to set up a real runner.

**Not verified: any of it in a browser.** `/builder` is auth-gated with no dev bypass, and the running server was `npm start` rather than `npm run dev`, so it was serving pre-change code. Layout and interaction still need a real look.

**What the rest of it landed as, and the parts worth knowing before touching any of it again:**

- **`ride.json` now carries per-leg spans.** It used to concatenate every leg into one flat `track` and drop leg durations, so a client could not tell where one leg ended—mapping a moment to a leg was impossible from the public contract. Each route now also carries `legs[{ distanceM, durationS, startIndex, endIndex }]` indexing into that same unchanged `track`.
- **That concat drops _any_ consecutive duplicate, not only the joints between legs.** `sample-route-one` carries 33 repeats inside a single leg. Harmless when the output was one flat line; load-bearing now that indices point into it.
- **Consecutive legs do not always share a joint.** Real routes produce both—one demo ride shares its joints, another has a one-point gap between its first two legs. **Never test `legs[i].startIndex === legs[i-1].endIndex`**; it fails on real data.
- **`map-common.js` gained a leg highlight** as one spare `Polyline` per map, sliced from the route's own line. Additive on purpose: a `Polyline` per leg would have changed the layer-id contract every caller depends on, in a file #6, #8 and #9 also touch. Three engine paths drop a live highlight—`removeRouteLayers`, `updateRouteTrack` (which fires on every leg recompute in the builder) and `setRouteVisible(false)`—and callers re-apply. A highlight that briefly vanishes is a far smaller lie than one drawn over the wrong road.
- **The time model lives in `public/js/ride-time.js` (`window.TBTime`), shared by both clients.** Not copied into each: the builder resolves a moment from legs held in memory, the viewer from legs `ride.json` sends, and the same ride must land on the same leg in both. This is the lesson `map-common.js` already records about marker construction.
- **A moment at a stop is on no leg, and the overnight gap between days belongs to no day.** Both say so rather than lighting the leg just ridden. The readout carries the difference in words, so the map is never the only explanation.
- **The builder keeps two controls over one model.** `state.moment` is the source of truth when set; the day slider does not compete with the timeline, it _picks a moment_ (that day's start). A null moment falls back to plain day focus, which is what an undated ride uses throughout.
- **In the viewer, hover outranks the timeline while it lasts.** Both wanted to dim, and before this, leaving a hovered legend row called `highlight(null)` and silently discarded the timeline's state. Both now resolve through one `paintFocus()`.

**#19 (`e859d6e`) contradicted a comment on purpose.** The old note argued even tick spacing was deliberate because the thumb inset made alignment impossible. Wrong twice: the inset is knowable (a thumb center travels between half a thumb from each end, so the usable track is `100% - thumb`), and `space-between` was aligning label _edges_, not centers, which drifted further off than the inset ever did. Measured in Chrome at 320px: centers now land within 0.01px of the computed thumb positions, against 4.18px before.

**Verification.** Typecheck, the SCSS build, and five scratch suites covering the shared time model, the builder's date handling and leg spans, the highlight overlay, and the server's span computation—including one that runs the real server loop against the real builder function to prove they agree. A database-backed check asserted the span invariants over every ride present at the time (21 routes / 71 legs / 16 rides). The viewer was driven in Chrome; the builder was checked by the owner. **None of the scratch suites are in the repo**—they work by string-extracting functions out of source, which is fine as a scratch check and a bad thing to enshrine while [#21](https://github.com/feralcreative/tankbag/issues/21) is open to set up a real runner.

**#27 overlaps and was deliberately left out.** The leg-plus-dwell duration formula landed here, so what remains of that issue is the configurable rest cadence—which needs its own storage decision and a call on whether a generated rest break becomes a real `points` row or a display-only overlay.

**Removed 2026-08-06:** a paragraph sat here claiming the even tick spacing was deliberate and that the thumb inset made exact alignment impossible. It contradicted the `e859d6e` note four paragraphs above it, which had already measured the fix. It was the _pre-fix_ argument, left in place after the fix landed. Kept as a marker rather than deleted silently, because a document that argues with itself is worse than one that is merely behind—a reader has no way to tell which half is current.

<!--| PAGE-BREAK -->

## Sprint 4: UX and the naming model—2026-08-01

Branch `style/ui-tweaks-and-cleanup`, nine commits, from `_PLANS/sprint-04-260801T2122Z.md`. Five commits are splash-page styling; four change how a rider gets named.

### The point of the naming work

**No rider's real name is adopted from Google and shown anywhere they did not choose.** That is the whole intent, and the code carries it in comments because the code alone will not survive a well-meaning edit:

- **`name` is gone from `GoogleClaims`** ([google.ts](../src/auth/google.ts)) and must not come back. It used to flow straight into `users.display_name`, which is what the nav, the dashboard greeting and the admin rider list all render—so signing in with Google silently published whatever Google held.
- **`picture` was never added, for the same reason.** Note `users.avatar_url` exists and is never written, which makes wiring that claim to it look like finishing an unfinished job rather than opening a hole. The comment on the type says so.
- **`given_name` / `family_name` _are_ read**, and go to `user_profiles.first_name` / `last_name`. The distinction is where they surface: that table exists precisely so private fields never ride along on a row reaching a client, and nothing renders them to anyone but the rider. `share_last_name` is written but has **no reader anywhere in the app**.
- **What makes that acceptable rather than merely currently-harmless** is that the profile form shows both names as ordinary inputs directly above the toggle that would expose the last name, so a rider flipping it can see what it reveals. Move those fields somewhere less visible and the seeding stops being defensible. That reasoning is in [identity.ts](../src/auth/identity.ts) next to the code.

### The model, settled after two reversals

**`username` and `display_name` stay discrete.** They were briefly going to merge, until the cost surfaced: `username` is `[a-zA-Z0-9_]`, so a merged field means no spaces in the name anyone sees. `display_name` is free-form and stays what gets rendered; `username` is the handle.

**Neither is prefilled.** Both are blank and required at `/choose-name`. `display_name` is `notNull` and the row must exist before a rider can be shown anything, so `resolveUser` fills it from the email address alone and the prompt overwrites it—that placeholder is visible only in the nav, between signing in and answering.

**`users.public_id` is `{first-username}-{YYMMDDTHHMMZ}`**, e.g. `ziad-260801T2220Z`. Deliberately **not** called a UUID, because it is not one. Written once when a username is first chosen and never again, so a later change leaves every existing reference resolving. Built from explicit UTC getters: `users.created_at` is `timestamp` _without_ time zone, so the `Z` is a promise the server's clock zone must not get to break.

**A released username is held for 30 days**—but never against the rider who released it, which is the entire feature. `username_history` records every name held; `uq_username_lower` stays the hard guard, since "unavailable unless you are the one who let it go" is not something an index can express. The hold is therefore an application check and the unique-violation catch is still the real backstop.

**Everything about usernames lives in [auth/username.ts](../src/auth/username.ts)**—reserved list, schema, availability, `publicIdFor`, `claimUsername`. Two callers now (the prompt and the profile form) and they must not drift.

### Read this before the next schema change

Kept because the hazard outlived the tool. The workflow moved to generated migrations on 2026-08-10, which removes the prompt below—but not the underlying problem, which is a differ that does not know what you meant.

Adding a nullable column and a table sounds harmless. The push offered to destroy the users table to do it:

```text
· You're about to add users_public_id_unique unique constraint to the table,
  which contains 4 items. If this statement fails, you will receive an error
  from the database. Do you want to truncate users table?
```

**`--force` auto-answers prompts like that.** It would have wiped every account to make room for a constraint that did not need it—existing `public_id` was NULL everywhere, and NULLs never collide in a unique constraint. The correct answer is no.

The DDL was applied by hand in a transaction instead, matching drizzle's own naming, and a follow-up `push` reported no changes, which is how you confirm the names line up. Do that rather than gambling on a prompt default you cannot see in a non-TTY.

Under generated migrations the same case shows up as SQL in a file you can edit before anything runs—the constraint statement is there to read, and the fix is to keep it and drop the truncate. **`push` reporting no changes remains the way to verify a database matches `src/db/schema.ts`**, which is exactly the check a baseline depends on.

### What a returning rider will hit

Existing accounts created before this sprint have `username = NULL`. `requireActive` and `requireManageRiders` now redirect those to `/choose-name`, so **every current account gets the prompt on its next visit**. That is intended, not a migration gap—there is no sensible name to invent for them, which is the point.

`/choose-name` and `/logout` run on `requireAuth` rather than `requireActive`, which is what keeps the gate from looping.

### Left undone, deliberately—since fixed

The **"Sign out" link on the holding page** was `$url` blue directly over the video: 2.94:1 against bright gravel, 2.33:1 against dark foliage, both failing WCAG AA. **Fixed 2026-08-02 ([#45](https://github.com/feralcreative/tankbag/issues/45)).** It stayed a link rather than becoming a fourth button—it is genuinely a lighter action than the three resource buttons beside it—and took the same white-plus-text-shadow treatment as every other piece of over-video text on the splash. The reasoning sits beside the rule in [\_splash.scss](../style/_splash.scss).

## Public surfaces—2026-08-01

Branch `feat/legal-and-faq-pages`, eight commits. Closes [#45](https://github.com/feralcreative/tankbag/issues/45), [#14](https://github.com/feralcreative/tankbag/issues/14) and [#26](https://github.com/feralcreative/tankbag/issues/26); takes half of [#12](https://github.com/feralcreative/tankbag/issues/12) and the two pages [#18](https://github.com/feralcreative/tankbag/issues/18) wanted.

### The home-address exposure—read this before touching ride starts

A rider with `add_home_to_rides` on gets a first stop seeded at their house, named **"Home"**, carrying the `home` role, at six-decimal precision. `ride.json` sends `lat`/`lng`/`name`/`roles` to anyone with a share link. **Sharing such a ride publishes a map pin on your front door.**

**Moving the pin does not fix it, and this is the part that is easy to get wrong.** The first leg is _drawn_ from the house: the line points at the building whatever the marker says. Relabeling or nudging the marker leaves the geometry intact. The substitution has to happen while planning, and leg 0 has to re-route.

So `user_profiles` gained a second address—`start_label`, `start_address_line`, `start_city`, `start_state`, `start_postal_code`, `start_lat`, `start_lng`—mirroring the home block field for field. When a ride whose first stop carries the `home` role is switched to public or unlisted, the builder **offers** the swap, then rewrites the stop, drops the `home` role, clears shaping points and recomputes leg 0. Offered rather than applied: the rider may have meant to share it, and silently redrawing a planned route is worse than asking. Declining is remembered for the session.

The profile copy pushes a gas station, coffee shop or trailhead—somewhere you could actually meet people.

**Still open:** rides already shared are unchanged. This only helps from the next visibility change onward.

### What is public, stated once

Every public surface reads the same rule. It is written out in `pages.ts` so it is not reconstructed per template:

|        |                                                               |
| ------ | ------------------------------------------------------------- |
| shown  | username, display name, public rides                          |
| opt-in | last name, and only via `share_last_name`                     |
| never  | first name, email, home address, coordinates, payment handles |

Payment handles are **never**, not opt-in, even though `share_payment_handles` exists. They are for settling up with people you are riding with, which is a relationship the app does not model yet (#12). A handle on a public page is a payment request open to strangers. Verified by seeding a profile with everything filled in and grepping the rendered page for each field.

### Routing gotcha

**Hono does not match `/@:username`.** A literal prefix in front of a param never fires and the route 404s silently. A regex param does work:

```text
pageRoutes.get('/:handle{@[A-Za-z0-9_]{3,30}}', …)
```

Pinning the charset to the username rule means a malformed handle 404s at the router rather than reaching a query, and `/faq`, `/login` and the rest are unaffected.

### The rest of it

- **`/explore`**—public ride gallery, sorted by views or recency, 24 a page. Offset paging with `LIMIT PER_PAGE + 1` so "is there a next page" costs no second query. This is the only query in the app whose row count grows with the whole userbase.
- **Clone**—`POST /api/rides/:id/clone` rebuilds a public native ride through the same `insertRideGraph` the builder uses, so a clone is a first-class ride rather than a second representation. **Drops** every description (stop notes are where "gate code 4417" lives), start and end times, and via points; lands **private** regardless of the source. Private and imported rides 404 rather than 403, so the endpoint confirms nothing.
- **`/riders`**—read-only roster, same fields as a public profile because it is the same question in bulk. Signed-in only: the data is already public, but an anonymous list of every account is a scraping target with no upside.
- **`auth/ratelimit.ts`**—one sliding-window counter, extracted from the inline guard that was magic.ts's alone. Three callers now, including `POST /choose-name`, which sprint 4 shipped as an unlimited enumeration surface. **In-memory and per-process**: honest for one container, not a distributed limiter. magic.ts keeps its database-backed per-email count, which has to survive a restart.
- **`views/cards.ts`**—`rideCards` moved out of `index.ts`, which had become a circular import once `pages.ts` needed it. It only worked because the call was deferred to request time.
- **FAQ, privacy and terms** at `/faq`, `/privacy`, `/terms`, all readable signed out. `/privacy` has to be: Google's consent screen review fetches it anonymously, and the screen cannot be published past its 100-user cap until it resolves. A site footer carries all three; map pages get them from the nav instead.
- **`utils/tighten-em-dashes.mjs`** plus a `core.hooksPath` hook. Em dashes are tight everywhere now, with no table exemption—use a spaced en dash when a line needs air.

### The FAQ said things that were not true

`docs/ops/faq.md` promised **"No limit"** on stops, days and miles in three places. The real caps are 31 days, 200 stops a day, 200 POIs and 200k points a ride. The published copy carries the real numbers, which argue better anyway: 200 stops a day against Google My Maps' ten is checkable, and "unlimited" is a promise the app breaks at the wall. Also corrected "a dozen" stop roles to the actual 17.

## Mapbox and the second viewer are gone—2026-08-01

Branch `refactor/retire-mapbox-and-legacy-viewer`, five commits. ROADMAP item 1. Closes #20, most of #6, and #21.

### The finding that resized the sprint

Item 1 said "teach the current engine to draw an imported ride's single-leg track, then collapse the two viewer shells." **The first half was already done.** Forcing the ported shell for every ride and loading `sample-route-one` rendered it completely—all 5,743 track points, 26 role markers, mileage, GPX and KML buttons—with **zero console messages**.

`ride.json` has served both sources identically since the timeline work added per-leg spans; an imported ride is simply one route with one leg. So the work was flipping a conditional and deleting **1,135 lines**, not porting a renderer. Worth checking assumptions like that before scoping: this one turned the sprint's biggest item into one of its smallest.

### What went

- **`public/js/main.js`**, the legacy Google shell, and `viewHtml`'s twin.
- **`/api/public/maps/:slug`**, the legacy metadata JSON, and `firstRouteColor`, its only caller. **`/kml` and `/gpx` under the same prefix stayed**—those are the file downloads `ride.json` still points at, and deleting them would break every imported ride's download buttons.
- **`viewerPanel`'s `timeline` flag.** It existed only because the legacy shell could not wire the control. With one shell it is unconditional, so imported rides get the timeline as soon as they carry dates.
- **`MAPBOX_TOKEN`, `MAPBOX_GL_VERSION`, `MAPBOX_CSS_LINK`** and every config, compose, deploy-guard and `.env.example` reference. Remaining mentions in the tree are historical comments explaining why things are shaped as they are; those are worth keeping.

Note the NAS `.env` still carries `MAPBOX_TOKEN`. Nothing reads it and the deploy script no longer requires it, so it can go next time that file is touched.

### `POST /api/geocode`

The last Mapbox call, moved server-side beside `POST /api/route` and for the same reason: the key that may call Geocoding is IP-restricted to the server, so a browser cannot use it.

Two things worth knowing. **A miss is cached as well as a hit**—a half-typed address gets resubmitted constantly and a failed lookup bills the same as a successful one. And Geocoding reports "found nothing" as **HTTP 200 with `ZERO_RESULTS`**, the same shape as Routes reporting "no path" as 200 with an empty array; both are handled explicitly rather than falling through as success.

### Tests exist now

`vitest`, 43 tests, `npm test`. Deliberately narrow: the pure logic that had been hand-verified more than once across three sprints—the trip time model, the username rules, the prose tightener. Anything needing a database or a browser stays out and is still checked by hand.

**Both suites were verified by breaking the code they cover**, because a suite that passes on broken code is worthless. Switching `publicIdFor` from UTC to local time failed three tests; removing the tightener's inline-code masking failed two.

### The hook ate its own test file

Committing `test/em-dashes.test.ts` ran the pre-commit tightener over it, and it rewrote the **fixtures**: `fix('a — b')` became `fix('a—b')`, so half the assertions compared a string to itself. It committed reporting 43 passing while testing nothing.

Fixed twice over, on purpose:

1. Every fixture is built from escapes (`const EM = '\u2014'`), so no literal spaced em dash exists in the source and no formatter can reach them.
2. `utils/tighten-em-dashes.mjs` skips `test/` and `*.test.ts`.

**The general shape of this is worth remembering:** anything the hook rewrites in place can corrupt data that merely looks like prose. Snapshot files and sample documents would want the same exclusion.

### Left for you—the Mapbox retirement

All but one of these is now done. Kept because the reasoning is still worth having, and struck through so nobody works them again:

- ~~**Favicons** still carry the old routeloop mark, including the `og:image` social card.~~ **Done**—regenerated 2026-07-31 in `22610b8`, [#55](https://github.com/feralcreative/tankbag/issues/55) closed 2026-08-02. `og:image` points at `og-card.png` since 2026-08-09 (it was the bare `logo-tankbag-horiz-light@2x.png` strip until then). This item was restated as outstanding in two later sections of this file for four days after it was finished; see the note on checking assets before believing a checklist.
- **Remove the Cloudflare Access policy** at the edge. The app has ignored its header since `17de208`. **Still open**, and the only edge-side item left.
- ~~**Set per-API daily quota caps** on the GCP project.~~ **Done 2026-08-02**—five metrics capped, see "Console hardening" above.

## Sprint 07: the editing panel, and twistiness—2026-08-02

Branch `fix/editor-interface-sizing`. All eleven items from `_PLANS/sprint-07-260802T1618Z.md`, seven commits, 88 tests.

### What went in

| Item   | Result                                                                 |
| ------ | ---------------------------------------------------------------------- |
| 1      | The day slider picks the working day; "All" is a view                  |
| 2      | POIs interleaved by distance, and they carry a duration                |
| 3, 7   | Panel grouped into ride / trip / day bands, day icons tinted its color |
| 4, 5   | Time stopped replaced by **twistiness**, with an FAQ entry             |
| 6      | Panel terms link to their FAQ answers                                  |
| 8      | Nav's last four items folded into an About submenu                     |
| 9      | FAQ is an accordion with stable anchors                                |
| 10, 11 | Bio years computed at render; tagline removed                          |

Plus one unplanned commit: the 24 `darken()`/`lighten()` calls became `color.adjust()`, so the SCSS build is silent rather than emitting 38 deprecation warnings that had been getting waved through.

### Twistiness, and why its first spec was wrong

Degrees of heading change per mile, computed from geometry alone—so it works on imported rides, which never touch the router and could never have a turn count. Stored on `routes` as `twistiness_dpm` and `twistiness_best_dpm`, both nullable, because null ("not measured") is a different claim from 0 ("straight").

The thresholds were measured against the dev corpus twice, and the first set was badly wrong in a way only synthetic fixtures exposed:

- **A 5° deadband discarded every sweeper.** A magnitude threshold at 25m spacing silently zeroes any curve gentler than `R = 25 x 57.3 / deadband`—286m at 5°. A continuous 400m-radius arc, which geometry says must score 231°/mi, came out as **0**. So did 800m and 1500m. Comparing rides to each other never caught it because they all lost their sweepers equally. It is 1° now, and the metric tracks true curvature from R=800m down to R=50m.
- **A 5-mile "best stretch" window finds towns, not roads.** Street corners are denser than any road bend, so every day in the corpus scored 122–1010°/mi—desert interstates included—and the number discriminated nothing. At 20 miles the desert days fall to 35–63 while genuinely twisty ones hold 300–493.
- **100m spacing is disqualified at the other end**: a 100m chord across a 50m hairpin is wider than the corner, so a switchback scores zero.

The builder computes it live rather than reading the stored figure, because the stored one is stale the moment a stop moves. That means two implementations, so `test/twist-client.test.ts` runs both over ten named fixtures and asserts integer equality—the same arrangement `ride-time.js` has.

### The bug that made the panel feel broken

`editIndex()` was `state.focus === 0 ? state.routes.length - 1 : state.focus - 1`. On "All", edits landed on the **last** day, for no stated reason, with no control that changed it—and the panel announced "All days · editing Day 4" as though that had been asked for. It returns `null` now and the day section is replaced by a prompt. With one day, "All" and "Day 1" are the same view, so editing stays on.

### POI dwell rewrote the time model

A POI is not a routing anchor, so a pause at one falls _inside_ a leg rather than between two of them. The old `activeAt` alternated stop-dwell and leg-riding and had nowhere to put that. `routeSchedule()` in [ride-time.js](../public/js/ride-time.js) emits the day as a list of segments instead, which is both expressible and testable—the suite now asserts that the schedule's total always equals `routeElapsedS` (which every stored end time and the timeline slider depend on) and that it never emits a gap or an overlap.

### Three bugs the work surfaced

1. **The twistiness cache was already broken when it shipped.** It keyed on the `route.legs` array identity, but the builder mutates in place—`route.legs[i] = leg` on a reroute, `legs.splice()` on a delete—so identity never changes and it would have served pre-reroute figures forever. Both caches use content signatures now.
2. **`/api/rides/:id` did not return POI `durationMin`**, so a saved dwell would have vanished on the next load. Caught by round-tripping through the API rather than by reading the code.
3. **The clone path dropped it too**, caught by `tsc` when the payload type gained the field. Cloning would have quietly shortened every day.

### Left for you—sprint 07

- ~~**Favicons** still carry the old routeloop mark, including the `og:image` card.~~ **Done**—this was already finished when it was written here. See the Mapbox-retirement list above.
- **The twistiness bands need real rides.** They are calibrated on machine-generated demo rides across California, not rides anyone chose for being good, so real trips will skew twistier. One exported const in [twist.ts](../src/maps/twist.ts). **Still open**, and the import path built in sprint 09 exists specifically so this can finally happen.

<!--| PAGE-BREAK -->

## Sprint 09: getting routes in and out—2026-08-03

Branch `feat/import-export`, fourteen commits. The app now reads six formats and writes five, imports a folder of files as one multi-day trip, and prints a roadbook.

**The reason for the sprint was narrower than what it became:** there was no way to get a real GPX into the app, so the twistiness metric had never seen a road anyone chose for being good. `POST /api/maps` had existed since the pivot and was reachable only by API—nothing in the app rendered a file input—and it rejected any upload without a `.kml`. A rider with a folder of GPX files, which is what every GPS produces, had no way in at all. `processGpx()` had been written, complete, and left unreachable with a comment saying it would be wired up "when the import UI accepts GPX without a KML". Nobody had filed that, so it never got scheduled.

### What the pipeline reads and writes

| Format       | In  | Out | Notes                                                                          |
| ------------ | --- | --- | ------------------------------------------------------------------------------ |
| KML          | yes | yes | stored sanitized and re-serialized                                             |
| KMZ          | yes | no  | unzipped to its KML; `source_format` remembers it arrived zipped               |
| GPX          | yes | yes | **stops are `<wpt>`, shaping points are `<trkpt>`, never `<rte>`**             |
| GeoJSON      | yes | yes | the only interchange format that keeps roles, stop/POI and dwell               |
| CSV          | yes | yes | a stop list, not a route: no geometry, so no mileage and a **null** twistiness |
| Tankbag JSON | yes | yes | **lossless**—the builder's own save payload                                    |

Every format goes through the pipeline unchanged: auth → origin → Turnstile → size cap → **DOCTYPE rejection** → strict parse → sanitize → transactional quota under `FOR UPDATE` → file writes named only from integer ids.

### The GPX decision that the app's promise depends on

**GPX export writes stops as `<wpt>` and shaping points as `<trkpt>`. Nothing is ever written as `<rte>`/`<rtept>`.** A route file is a list of places to navigate _between_, so a device given one picks its own way from each point to the next—usually the fast way, rarely the good one, and a missed turn throws out the rest of the day. That is exactly the failure the FAQ describes under "Why does my GPS ignore the route I planned?", and the answer there is that Tankbag puts in enough intermediate points to leave the device no room to form an opinion. Exporting those as route points hands the room straight back. There is a test asserting `<rtept>` never appears.

### Multi-file import

Several files posted at once become the days of one ride, in order, because that is what a rider with a per-day folder actually has—importing them one at a time makes one ride per day and no trip. Day titles come from filenames, colors walk the shared palette, and every original is kept (`{ride_id}-{n}.{ext}` from day 2 on). Verified against a real 3-day ride exported to three GPX files and re-imported: per-day twistiness came back **79/69/53**, identical, with exact point counts.

Files are all validated before any is parsed, so a bad tenth file fails the upload and names itself rather than leaving nine days half-imported.

### The storage decision, and the one I got wrong first

`rides` gained `source_format` and `source_bytes`, and `size_bytes` is now generated from all three byte columns (see `utils/deploy/sql/2026-08-03-ride-source-format.sql`).

**Every format keeps its original.** GeoJSON and CSV briefly stored nothing, on the theory that the rows were a complete record of the upload. They are not: import flattens a multi-day file to one route, so the day structure existed in the uploaded file and then existed nowhere—destroyed, not deferred. That reasoning was written down and shipped before it was corrected, which is worth knowing if a similar argument turns up again.

**`size_bytes` must name every byte column.** `used_bytes` is incremented by the app on import and decremented by this generated column on delete. They are computed by different sides and quota drifts permanently if they ever disagree—so a new byte column that is not in the expression leaks a little on every delete, silently. Verified balanced across all four formats: import adds N, delete returns to exactly the starting figure.

### Downloads are source-aware

An imported ride streams its stored original for the format it arrived in—byte-for-byte, which is the entire reason the file is kept—and every other format is generated from the rows. So a KML import downloads as GPX, and a ride built here downloads as either, neither of which was possible before.

**Every branch tests `source_format`.** A multi-file import stores `'mixed'`, which matches nothing, so those rides always generate. Without that a three-KML import would have streamed **day 1's file as the whole ride**, since `kml_bytes > 0` was true. Caught by testing rather than by reading.

### The roadbook (#25)

`/m/:slug/roadbook`, server-rendered, no JavaScript, print CSS for US Letter.

**Stop-by-stop, not turn-by-turn, and that is a data limit rather than a choice.** `route_legs` holds geometry, distance and duration; maneuvers are a separate field on the Directions response, they are what the call is priced on, and they would be blank for every imported ride regardless. What it prints is the part that stays true when a road closes: stops in order, leg and cumulative miles, **miles since fuel**, planned dwell, and an estimated clock when the day has a start time.

The fuel column is the one nothing else in the app says. It reads _as you arrive_, so a fuel stop shows the distance the last tank actually covered rather than the 0 it is about to reset to.

### Bugs the work surfaced

1. **A multi-day GPX re-imported 78 miles longer than it left.** `processGpx` read every `trkpt` across all `<trk>` elements as one track, inventing straight lines between where one day ended and the next began: 553 miles came back as 631, and twistiness fell from 79/69/53 to **59** because the phantom joins are perfectly straight. A confident, wrong number for the metric this sprint existed to make trustworthy. The longest `<trk>` wins now, while `<trkseg>` breaks _within_ a track are still joined—those are recording pauses in one ride.
2. **KML and GeoJSON disagreed on a degenerate line.** KML read a one-point line as a zero-length track; GeoJSON rejected the whole file with "contains no lines or points". Found by the cross-format tests on their first run, which is what they exist for.
3. **`tsc --noEmit` had never type-checked the tests.** `tsconfig.json` included only `src`, and vitest transpiles without checking, so fixtures could drift from the types they claimed to be—and had. Adding `test` exposed 8 real errors in suites that were passing.
4. **The roadbook 500'd for an anonymous request** to a private ride: `currentUser()` throws outside an auth gate. 404 now, like every other gated route.
5. **POIs with no measured position printed `0.0`**, a claim about where they are rather than an admission that nobody measured. They sort last and print a dash.

### Qlty, and 13 findings that were all wrong

SonarCloud was retired (258 findings, of which 16 were real) and replaced with a tuned Qlty config. Two things worth knowing:

- **Qlty does not read the repo's `.prettierrc`.** Not from the repo root, not from a copy in `.qlty/configs/`, not via a `config_files` entry—all three were tried. It formats with its own defaults, and the one that bites is `singleQuote`, which `.prettierrc` explicitly turns _off_ for SCSS. It was flagging **13 of the 14 SCSS files** purely over `@use "tokens"` versus `@use 'tokens'`, disagreeing with the project's own config and with `npx prettier`. SCSS is excluded from Qlty's prettier now, with the reasoning in `qlty.toml`.
- **Biome ships its own formatter** and disagrees with prettier, so leaving both on made every file permanently "unformatted" according to one of them. Prettier owns formatting; biome is the linter.

### Left for you—sprint 09

- **The twistiness bands still need real rides.** This is the whole point of the sprint and the one thing it could not do for itself: import a folder of GPX files from trips you actually took and read the labels against roads you know. One exported const in [twist.ts](../src/maps/twist.ts).
- **Single-file multi-day import.** A GeoJSON or KML that contains several days still imports as one route with the longest day as its track. Every point survives; the day structure does not. The originals are now kept, so this is recoverable later rather than lost—which is exactly why they are kept. Closes no issue; asserted in `test/round-trip.test.ts` so it fails loudly when fixed.
- **~34 pre-existing prettier findings** in files this branch did not author. Clearing them means a repo-wide formatter run, which the house rule rules out.

<!--| PAGE-BREAK -->

## Single-file multi-day import—2026-08-04

Branch `fix/multi-track-import`, closing [#70](https://github.com/feralcreative/tankbag/issues/70). Sprint 09 left this as its known limitation and asserted it in `test/round-trip.test.ts`, so fixing it failed that test loudly—which is exactly what the assertion was for.

A file holding several tracks now lands as several days, names and all. Before this the longest `<trk>` won and every point in the others was dropped. The parse returns `tracks[]` rather than one `track`, and `src/routes/maps.ts` turns each into a route.

**Points are bucketed to the nearest track, not split by document order.** A file's placemarks are not guaranteed to sit in the same order as its lines, so `nearestTrackIndex()` assigns each stop to the track it is actually closest to. Ordering by position in the file would put day 3's fuel stop on day 1 whenever an editor wrote the folders in a different order. Day titles come from each track's own name; a single-track file takes the path it always did.

## Expand, and the Google Maps hand-off—2026-08-04

Three commits on `feat/expand-route`, closing [#65](https://github.com/feralcreative/tankbag/issues/65) and [#66](https://github.com/feralcreative/tankbag/issues/66). This is the feature that answers "so how do I actually ride it?"

**`src/maps/expand.ts`** densifies a planned route by inserting shaping points along geometry that is already stored, so whatever the rider navigates with has no room to pick its own roads. Two decisions are argued in the file's own header and should not be relitigated:

- **It is deliberately not verified against a router.** The tempting design—ask the router for A→B, diff it against the intended line, insert a point wherever they disagree—is close to tautological, because `route_legs.geometry` _is_ Routes API output; it agrees, and costs dozens of calls to discover that. It also defends against the wrong router. The one that ruins a ride is never ours: it is the rider's own Google Maps carrying their avoid settings, or a Garmin recomputing after a missed turn. You cannot verify against a router you do not control, so the only defense is leaving it no room—and density is geometry, free and offline.
- **Turns first, then the longest unpinned runs.** A junction taken left is a junction a router could take straight through, so candidates are scored by heading change—the same signal `twist.ts` uses, asked a different question. Whatever budget the turns do not want goes to halving the widest gaps, because curvature cannot see a parallel frontage road and only proximity defends against one.

**`src/maps/gmaps-links.ts`** serializes a day into an ordered series of `/maps/dir/?api=1` links. **Google Maps carries 9 waypoints per link**, established on a real iPhone rather than from the documentation—the "~10 points" figure in older docs was an assumption, and Google's own docs are wrong about the part that matters, since their three-waypoint figure applies to a route rendered in the mobile browser and not to the app the link hands off to. Omitting `origin` makes Maps use the rider's current location and offer **Start** rather than Preview, which removes the "add Your Location and drag it to the top" ritual riders otherwise perform at every fuel stop. Consecutive links deliberately **share** a point: a clean partition would leave the leg between two batches unnavigated.

**`/m/:slug/navigate`** ([handoff.tsx](../src/routes/handoff.tsx)) is the page, on the same visibility gate as the viewer, with no JavaScript beyond plain hrefs because it has to work at a fuel stop on one bar. Density is off / light / tight, labeled by what the rider is actually choosing between—room for the nav app, against how many times they stop and tap—rather than by point counts. **It states the longest unpinned stretch rather than hiding it.** Between two consecutive points Maps routes however it likes, and saying so is the difference between this and every tool that claims a clean hand-off and delivers a route that wandered.

Raw coordinates render as "dropped pin". Named places need Google place IDs, which this app does not store yet; the route is exact and navigable either way, so names are an upgrade rather than a blocker.

## Contributor scaffolding—2026-08-05

Branch `chore/contributor-onboarding`, merged in #75. `CONTRIBUTING.md`, a PR template, rewritten issue templates, and **CI** at `.github/workflows/ci.yml`—typecheck plus tests on every pull request and on pushes to `main`.

**The Node matrix is the floor and the shipped version:** `package.json`'s `engines` floor is 22 and the Dockerfile ships `node:24-alpine`, so running both is what keeps the floor honest—a 24-only API would otherwise pass CI and break for anyone on 22. It was 20 and 22 until 2026-08-16; **Node 20 went end-of-life on 2026-04-30**, so every PR was being gated on an unsupported runtime. The three numbers move together. There is no database service, because the suite is deliberately scoped to pure logic. If a test ever needs Postgres, adding a service container should be a decision taken on purpose rather than something already sitting there.

**`package-lock.json` is committed now** (`064b4c9`). It had been gitignored, which meant `npm ci` could not run in CI or in the Docker build at all.

**The `.gitignore` trap, which is the one to remember** (`7beb77a`): the pattern was `Icon?`, meant for the macOS Finder `Icon\r` file. A bare `Icon?` matches **any five-character name**, so it had been silently swallowing `public/img/icons/`—every role icon in the app—for as long as it was there. Production had icons only because the deploy builds its image from the working tree rather than from git. 22 icon files landed in that commit.

Note the replacement pattern is a bare `Icon`, which no longer matches the `Icon\r` file it was written for. Nothing in the tree triggers it today, so this is a latent gap rather than a live one—but the pattern now ignores nothing.

## Autosave, undo and crash recovery—2026-08-05

Branch `feat/builder-autosave-undo`, merged in #78, closing [#38](https://github.com/feralcreative/tankbag/issues/38). The competitive research filed undo as a defection trigger rather than a nicety: "works pretty good at route planning until I mess up, then can't undo the mistake and have to start a new trip."

**Two protections that are deliberately not the same thing**, and [builder-history.js](../public/js/builder-history.js) says so at the top. _History_ recovers from a mistake you made and noticed—in memory, per session, lost on reload. A _draft_ recovers from a crash, a closed tab or a dead phone, **including for a ride that has never been saved and has no id**. Collapsing them into one mechanism means either a mistake surviving a reload or a crash losing everything.

**The snapshot trap, which has now fired twice.** What a snapshot copies is decided by what the builder mutates in place, and that is not uniform. `leg.geometry` is never mutated in place—it is always replaced wholesale—so it is shared by reference, which is what makes a snapshot cost ~50 object copies instead of ~19,000 coordinate pairs on a long day, and what makes a 100-step stack affordable. `point.roles` is the exception and **must** be copied, because `splice()` and `push()` mutate it. **`leg.viaPoints` was in the safe category until drag-to-shape started splicing into it**, and nothing failed loudly when that changed—the snapshot quietly gained the edit it was taken to protect against. A field is safe to share right up until someone adds the feature that mutates it.

Kept out of `builder.js` so it can be tested: `test/builder-history.test.ts` evals the file and drives `window.TBHistory`, the same arrangement `twist-client.test.ts` uses on `twist.js`.

## Drag-to-shape—2026-08-06

Branch `feat/drag-to-shape`, closing [#8](https://github.com/feralcreative/tankbag/issues/8)—the P0 that everything else in the planner quietly assumed. A rider can pull the route line onto the road they meant, and the dropped point becomes a via point on the correct leg.

**The hard part is arithmetic, not interaction.** A day is drawn as _one_ polyline—the concatenated geometry of all its legs—so a drag hands back a vertex index into that flat path and nothing else; the map layer has no idea where one leg ends and the next begins. [route-shape.js](../public/js/route-shape.js) turns that index back into "leg 3, between via 1 and via 2". It is pure—no DOM, no `google.maps`, no state—so `test/route-shape.test.ts` can drive it directly. An off-by-one here bends a route around the wrong corner, which is exactly the kind of thing that should fail in a test rather than on a map.

Two properties of the span array make it less obvious than it looks, both recorded in the file. **Legs share their joint vertex**, because the concatenation drops the duplicate where one leg's last coordinate meets the next leg's first—so a vertex sitting exactly on a joint belongs to both, and which one the rider meant depends on the segment they grabbed rather than on the vertex. And **a leg with no geometry has a null span and consumes no indices**, so it must be skipped without shifting everything after it.

This is also the change that turned `leg.viaPoints` into a field that has to be deep-copied for undo—see the snapshot trap above.

## The login page is a beta waiting list—2026-08-06

`/login` told visitors the opposite of the truth. It said "Not a member yet? Signing in creates your account", which is accurate in the narrow technical sense and reads as an open door—so a rider signed in, expected the app, and met the holding page instead. **The gate belongs on the way in, not after it.**

**The distinction the copy now carries, because it is the owner's and nothing in the code expressed it:** _alpha_ is developers only, and _beta_ is friends, invited a few at a time. So a visitor is not being kept from something they could otherwise have—beta does not exist yet—and the honest thing to offer them is a place in the queue.

**The mechanism did not change, and that is the point.** Signing in with Google or a magic link creates a `pending` user, `requireActive` bounces `pending` to `/welcome`, and `/admin` is the approval queue. That _is_ a waiting list. Building a second one—a `waitlist` table, its own endpoint, its own inbox to triage—would have added a store to reconcile against `users` for a capability the app already had. What was missing was the page saying so.

What changed, all copy and one CSS block:

- **`/login`** leads with a gate block: "You can't sign yourself in", then the alpha/beta split, then a link to `/faq#invites`. The controls became **Join the list** and **Join with Google**.
- **Sign-in is deliberately still here, through those same two controls.** The owner and every approved rider arrive on this page, and a page offering only a waiting list would lock out everyone who already has an account. `**Already approved?** Same control — it signs you in.` sits directly under them, which is the line doing the load-bearing work.
- **The nav says "Join the beta"**, not "Sign in". A nav offering sign-in contradicts the page it links to.
- **`/welcome`** names beta, so it agrees with the page that sent them there.
- **The FAQ** entry became "Why can't I just sign up?" and carries the alpha/beta split.
- **The sent notice dropped its hedge.** It used to say "if that address has access", presented as anti-enumeration. It protected nothing: `requestMagicLink` mails every valid address whether or not an account exists, so the responses were already identical and there was never anything to enumerate. It now says a link is on its way, which is both true and no more revealing.
- **Both controls are feature-flagged by omission**, as before, but the "no method configured" case is now stated once for the pair rather than only for Google—an empty box under an invitation to join is worse than saying the list is closed.

**The one constraint that shaped the design: the splash never scrolls.** `_splash.scss` pins `.splash` to one viewport and steps the stack down through two height tiers (`max-height: 760px` and `620px`). Anything added there is spent out of that budget, which is why the gate is two blocks rather than three and why `.splash-gate` is trimmed at both tiers. Measured in Chrome: the stack is 669px at 1440×900 against 837px of room, 599px at 1280×720, and 471px at 844×390—it fits at every tier with slack. The ~53px of page overflow at 1440×900 is pre-existing and structural (a static footer sitting below a `100svh` splash); the gate adds **1px** to it.

**The gate takes a solid scrim rather than the text-shadow every other over-video block uses.** That treatment is tuned to stay readable across most frames of the clip. This one has to hold on all of them, including the brightest—it is the page's whole message.

Verified in Chrome at 1440×900, 1280×720, 844×390 and 390×844 with zero console messages; `/login`, `?sent=1`, `?error=link` and `/faq#invites` all checked; and a temporary `pending` account confirmed the round trip—`/builder` 302s to `/welcome`, which renders the new copy. That account was deleted afterwards; dev is back to one user.

<!--| PAGE-BREAK -->

## The file naming convention and the drop box—2026-08-09

Sprint 11, from `_PLANS/sprint-11-260809T0206Z.md`, on a **second** branch named `feat/import-export`—the sprint 09 branch of the same name is long merged, so a search for that name finds two unrelated pieces of work. Route files now name themselves so a folder of them re-imports as the trip it came from, and the import page takes a drag.

### Why it exists, since the filename looks like decoration

**GPX and KML cannot carry a date.** `routes.start_at` survived a trip through Tankbag JSON and nowhere else, so exporting a planned trip as the format every GPS actually reads lost the schedule. That is the field the convention exists for; the trip name, day number and day title come along because they are free once there is a structure to put them in.

```text
tankbag_big-sur-run_d02_2026-08-14_lost-coast.gpx
 marker     ride     day    date       title
```

**What a filename does not carry, stated once so it does not get relitigated:** roles, dwell, via points, per-day colors and the stop/POI distinction. They do not fit and are not going in. `tankbag.json` remains the only lossless format. The ask that started this sprint was "all metadata intact", and the honest answer is that a filename is a four-field index, not a container.

**Visibility is deliberately not a field**—a file named `public` that publishes a ride on import is a footgun with no upside. **Nor is a timezone**, for the same reason the timeline work gave: `datetime-local` carries none and the app stores what the rider typed in their own zone.

### The three rules, and what breaks without each

- **Underscores separate fields, hyphens live inside one.** `slugField` guarantees no field contains an underscore. Drop that and a day titled "Lost_Coast" splits the filename into two fields and the date lands in the title.
- **The `tankbag_` marker is what makes a name structured.** Without it `parseExportName` returns null and every caller takes the pre-convention path. `test/filename.test.ts` carries a table of realistic rider filenames—`day-2.gpx`, `Track_001.gpx`, `Big Sur Run.gpx`—asserting none of them is read as structured.
- **Dates are UTC on both sides**, matching `fmtDate` in the roadbook. Local getters would let a roadbook and a filename disagree about which day a route is on. The test pins an instant that falls on 2026-08-13 in Pacific and 2026-08-14 in UTC, so it fails on a local-getter implementation when run on a workstation. **CI runs UTC, where both agree**—this guard bites hardest locally, which is the opposite of the usual arrangement and worth knowing before trusting a green CI run on it.

### Two implementations, held together by a test

`src/maps/filename.ts` and `public/js/filename.js`, because the drop box has to say what it read out of a filename before anything is uploaded and the server has no bundler to hand the TypeScript to a browser. `test/filename-client.test.ts` runs both over the same fixtures. Same arrangement as `twist.ts`/`twist.js` and `ride-time.js`, same reason.

### `src/maps/zip.ts` owns both directions now

The reader was `kmz.ts`'s private internals until the per-day archive gave the app a second reason to open a zip. It moved out unchanged and `kmz.ts` kept the policy that made it careful—one entry, the first `.kml`, everything else ignored. All 16 KMZ tests pass untouched, which is what made the refactor safe to do at all.

Two things the writer needed that the reader never did:

- **A correct CRC-32.** The reader does not verify CRCs, so nothing in the suite would have caught a wrong one—but `unzip` and macOS Archive Utility both refuse it, and a rider would have found out instead. Asserted against the standard check value, `crc32("123456789") == 0xCBF43926`.
- **`test/helpers/zip.ts` stays and is a different writer.** It builds deliberately malformed archives for the reader's tests and writes no CRC. Merging the two would take away the thing the KMZ tests are for.

**A per-entry cap does not bound an archive.** Fifty entries each a byte under the cap is fifty times the cap, so `readZipEntries` carries a running total and checks it as it accumulates rather than after the loop.

**macOS `__MACOSX/._name` resource forks are dropped.** Right-click → Compress on three files produces six entries; left in, the ride imports as six days with three of them binary junk.

### The route-ordering trap, which actually fired

`GET /api/public/maps/:slug/zip/:format` was registered _after_ the generic `:format` download route and was silently shadowed by it—`/zip/gpx` answered 200 with a plain GPX body and no attachment header. `/api/public/maps/:slug/nonsense/gpx` did the same, so the generic route is matching two-segment paths. Registering the zip route first fixes it. **Found by requesting it, not by reading the code**, which is the only way it was going to be found.

### Where a rider is told about it

Three places, and the first was initially missed—the convention shipped with nothing on the page where it gets used, which made it a format only the docs knew about.

- **`/import` carries a collapsed `<details>`** with the annotated example, what is literal, what is optional, and one line on why the date is the field that matters. Collapsed and labeled optional on purpose: every file that ignores the convention imports exactly as it always did, and a form that opens with a naming spec reads like a requirement. It explains itself inline rather than only linking out, because sending someone off the page to learn how to name files they are already holding is how it goes unread.
- **The viewer's per-day zip row links to `/faq#one-file-per-day`.** The panel is 380px wide and the answer is three paragraphs, so that one does link out.
- **Two FAQ entries**, `file-names` and `one-file-per-day`. Both are new ids, added to the `FAQ_IDS` contract in `test/content.test.ts` deliberately—that test exists to stop ids being renamed or dropped silently, and it failed until the list was updated, which is exactly what it is for.

### Verified

Against the running dev server, end to end: a three-day ride exported as `zip/gpx`, `unzip -t` clean, filenames carrying dates, re-imported through `POST /api/maps`, and the result compared against the original—**3 days in order, dates exact, twistiness identical at 79/69/53**, distances within 0.02 % (six-decimal coordinate rounding on export). Whole-ride download names also confirmed conforming. Typecheck clean, SCSS clean, 765 tests across 33 files.

**Not verified: the drop box in a browser.** `public/js/import.js` is checked by the parts of it that are pure—the convention it reads is covered on both sides—but the DOM wiring (dragover cancellation, `input.files` assignment from `dataTransfer`, the click-through to the picker) has not been driven in Chrome. The page renders the zone and both scripts with correct cache-busted URLs; that is as far as it was taken.

## Next steps, in order

**The Mapbox track that used to live here is finished** and its steps were removed on 2026-08-02 because they described work already done. Checked against the code rather than taken on trust: `public/js/main.js` does not exist, `nativeViewHtml` is gone and `viewHtml` is the only shell, no `MAPBOX_*` value is read anywhere (only historical comments remain), and `profile.js` geocoding already goes through `POST /api/geocode`. If you find a claim in this file that the code disagrees with, the code is right—that is what happened here, and it had already caused one bogus GitHub issue to be filed.

**The P0 tier is empty as of 2026-08-06.** Route shaping ([#8](https://github.com/feralcreative/tankbag/issues/8)) and autosave/undo ([#38](https://github.com/feralcreative/tankbag/issues/38)) both shipped, and the third P0 in the roadmap's list—the on-the-road mobile interface ([#69](https://github.com/feralcreative/tankbag/issues/69))—now carries a P2 label. The labels are the authority, so the roadmap's P0 section was rewritten to match rather than the other way round.

What is actually next:

1. **Point twistiness at real roads.** The import path exists now specifically so this can happen: bring in a folder of GPX files from trips you actually rode and read the labels against roads you know. The bands are calibrated on machine-generated demo rides and nothing in that corpus was chosen for being good. One exported const in [twist.ts](../src/maps/twist.ts).
2. **Remove the Cloudflare Access policy** at the edge. The app has ignored its header since `17de208`, and it has been deployed since 2026-07-30, so the ordering constraint that used to guard this is satisfied.
3. **Add the `www.tankbag.app` tunnel route.** The DNS record exists and nothing routes it, so the host returns a bare Cloudflare 404. The app already 301s `www` → apex; it simply never receives the request.
4. **Apply `utils/deploy/sql/2026-08-03-ride-source-format.sql`** on the next deploy, before or with the code that writes those columns—if it has not gone out already. It is additive DDL and safe to re-run; check `rides.source_format` on the target before assuming either way.
5. **The builder panel—roadmap item 16.** P1 was re-scoped on 2026-08-15 from the group layer to the builder, its tool panel and the map engine, because planning a ride fluidly is what the app is for and the panel has never been designed as one surface. Start with **autosave to the server**: it is the item the action row and the exit-guard question are both blocked on, and until it lands the only copy between saves is a device-bound `localStorage` draft. The group layer ([#71](https://github.com/feralcreative/routeloop/issues/71), [#72](https://github.com/feralcreative/routeloop/issues/72), [#73](https://github.com/feralcreative/routeloop/issues/73), [#12](https://github.com/feralcreative/routeloop/issues/12)) moved to P3—nobody is in the beta, so nothing needs it yet.

Sprint 08 (HTML out of the TypeScript) and the GCP quota caps are both done and merged.

<!--| PAGE-BREAK -->

## Known risks

- **Coordinate order** stays the likeliest bug. The app stores and speaks `[lng, lat]`; google.maps speaks `{lat, lng}`. Getting it backwards still renders, just in the wrong place. Routes API with `polylineEncoding: GEO_JSON_LINESTRING` returns `[lng, lat]`, so **no stored ride ever needed migrating**. Two functions do the conversion and only two: `toGoogleWaypoint` in [src/routes/routing.ts](../src/routes/routing.ts) on the server, and `toLatLng`/`fromLatLng` in [public/js/map-common.js](../public/js/map-common.js) on the client. Keep it that way.
- **The shared residential egress IP**—see above. Both environments and the workstation ride on one address.
- **Gmail sending caps** at roughly 2,000 recipients/day on Workspace, 500 on a consumer account. Fine for an alpha, a wall later.
- **Schema is generated migrations as of 2026-08-10, not `push`.** `drizzle/` exists and is committed; `npm run db:generate` then `npm run db:migrate`, and the deploy hook runs `migrate`. The `--force` hazard is gone with the flag—`migrate` has no prompts to auto-answer, which is why `deploy-utils.sh migrate` no longer passes it. **The new sharp edge is generation, not application:** the differ writes a rename as a drop plus an add, so read and rewrite the SQL before it runs. Full workflow in [database.md](database.md). Any database built by the old `push` workflow needs a one-time baseline before `migrate` will work against it—**prod and stage still do.**
- **The danger is the flag, not the database.** Production is a closed alpha with three accounts and they are all the owner's. Migrations and redeploys are cheap and should not be deferred out of caution—doing so on 2026-08-03 is what shipped GeoJSON and CSV imports that stored no original file, destroying multi-day structure that a stored file would have preserved. Be careful with the mechanics, not about whether to proceed.
- **`rides.size_bytes` must name every byte column.** It is generated from `kml_bytes + gpx_bytes + source_bytes`, and `used_bytes` is incremented by the app on import but decremented by this column on delete. A new byte column left out of the expression leaks quota on every delete, permanently and with no error.
- **Deploy the new auth code before removing the Cloudflare Access policy.** In the window between pulling the policy and shipping the code that stops trusting the injected header, the deployed build is wide open. The order is not a preference.
- **DNS is not the blocker; the un-deployed rename is.** All tankbag hostnames already resolve through the tunnel. As of 2026-07-30 the _live_ prod build predates the rename, so `tankbag.app` still 301s to `routeloop.app`—the correct routeloop→tankbag redirect lands only on the next deploy, not via any DNS change. **One real gap:** `www.tankbag.app` has **no DNS record** (`www.routeloop.app` does); add a proxied CNAME to the same tunnel, or the browser key's `www.tankbag.app` referrer entry is moot and the host won't resolve.

## Local development

```bash
cd /Users/ziad/www/moto/routeloop
npm install
cp .env.example .env          # see the file for what each value is for
docker compose up -d --wait db
npm run db:migrate            # generated migrations; npm run dev does this too
npx tsx src/db/seed.ts        # demo user + sample ride (needs storage/1/1.kml)
npm run dev                   # http://localhost:6686
```

Port 6686 is this project's port—kill and reuse it, never switch.

**Signing in without signing in: `DEV_LOGIN_EMAIL`.** Set it in `.env` to an address that already has an account and `http://127.0.0.1:6686/dev/login` puts you straight into a session as that user. It exists because checking `/builder`, `/welcome` or a profile page otherwise means minting a session token from a script and pasting a cookie by hand, several times an hour.

The app had something like this before—`DEV_AUTH_EMAIL`, deleted along with Cloudflare Access—so this is a considered re-add rather than a restoration. It is gated four ways and when any gate fails the route is **not registered at all**, making `/dev/login` a plain 404 rather than a refusal that confirms it exists:

| Gate                                                                 | Where                                                                                                           |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DEV_LOGIN_EMAIL` names an existing account (it will not create one) | `config.ts`, through `env()` so a deploy's empty string counts as unset                                         |
| `DATABASE_URL` is 127.0.0.1, localhost or host.docker.internal       | `isLocalDatabaseUrl()`, shared with the seeders' `assertLocal()`                                                |
| `APP_ORIGIN` is not https                                            | `IS_HTTPS_ORIGIN`—the strongest gate, since stage and prod break OAuth and cookie `Secure` if they get it wrong |
| The request's `Host` is 127.0.0.1 or localhost, not the LAN address  | per request, in the handler                                                                                     |

`utils/deploy/deploy.sh` builds the server's `.env` from an explicit allow-list, and `DEV_LOGIN_EMAIL` is not on it, so a deploy cannot ship it. The script greps the generated file to assert that before sending, and `--dry-run` exercises the check.

**Corrected 2026-08-03.** That guard originally refused to deploy at all while `DEV_LOGIN_EMAIL` was set locally, which was wrong on both counts: the variable could never have been shipped, and the check cost a manual edit before every single deploy. A guard that has to be worked around is a guard that gets deleted. It now verifies the artifact rather than the input.

**Rebuilding the local dataset: `utils/seed-dev.sh`.** Run this rather than the two seeders by hand. `src/db/seed.ts` opens with `TRUNCATE rides, user_identities, users RESTART IDENTITY CASCADE` and, unlike `utils/seed-demo-rides.ts`, carries **no check that the database is local**—so running it straight after a `db-clone prod dev` silently destroys every account you just pulled down. The script applies that missing guard, carries the accounts across the truncate and restores them by email (identity rows are not restored and are not needed: `resolveUser` falls back to matching on email, so signing in re-links each account), and only then generates rides—`seed-demo-rides.ts` looks its owner up by email, so run in the other order every ride lands on the demo user and is invisible from the account you sign in with. `--straight` skips the Routes API, which otherwise bills one call per leg.

**`db-clone prod dev` costs you the demo data.** Prod is nearly empty; dev is where the interesting rides live. One clone took the local corpus from 16 rides / 21 routes / 71 legs to a single one-leg ride, taking `sample-route-one`—the only _imported_ ride, and therefore the only local test case for the single-leg track path that Phase 4 and #6 both turn on—with it. `utils/seed-dev.sh` puts it back.

- There is a shared tmux session named `shared`; the dev server runs in its own window. Backgrounding it in the main window gets it **suspended on tty input**, where it holds the port and answers nothing. Two such zombies were found and cleared on 2026-07-27, in state `TN`. If requests hang with the port bound, that is the cause—`kill -CONT` then `kill -9`, since SIGTERM never reaches a stopped process. Orphaned `npm run dev` trees also survive a directory rename with their cwd pointing at the old path; three were cleared on 2026-07-30.
- **Either `localhost` or `127.0.0.1` works.** The old advice to prefer `localhost` was a Mapbox token restriction and no longer applies—the Google browser key allows both on port 6686, and `isAllowedOrigin` accepts both so the CSRF gate passes either way.
- `public/style/main.min.css` is a gitignored build artifact—`npm run sass`.
- `.prettierrc`: width 120, single quotes and no semicolons for `src/`, with overrides so `public/js` keeps its double quotes and semicolons.

### The Compose project name is pinned, and why

[docker-compose.yml](../docker-compose.yml) declares `name: tankbag`. Compose otherwise derives the project name—and therefore the **volume prefix**—from whatever directory it runs in, so renaming the checkout orphaned the data volume: `docker compose up` built a new empty `tankbag_tankbag-db-data` while every row sat in `routeloop_tankbag-db-data`, and the container name collided rather than failing cleanly. This is the identical trap `deploy.config` warns about on the NAS, and it fired locally first.

Migrated on 2026-07-30 by copying the volume rather than dump/restore, which keeps the cluster byte-identical:

```bash
docker run --rm -v OLD_VOLUME:/from:ro -v NEW_VOLUME:/to alpine sh -c 'cd /from && cp -a . /to/'
```

All `routeloop`-named Docker objects—two volumes, a network, and the `routeloop:latest` / `routeloop:stage` images—were removed the same day. Nothing named `routeloop` remains in Docker.

## Deploy

```bash
./utils/deploy/stage.sh --dry-run
./utils/deploy/stage.sh             # stage.tankbag.app
./utils/deploy/prod.sh              # tankbag.app
```

Prod refuses a dirty tree or a non-`main` branch; `--force` bypasses both gates but never the confirmation. Stage has neither gate, so it works from a feature branch—that is the one to use for this branch.

### First deploy after the tankbag rename—read this or lose the stack

`NAS_DEPLOY_PATH` is derived from `$DOMAIN`, which is now `tankbag.app`. Deploying without preparation does **not** rename the live stack; it builds a second, empty one at `/volume1/web/tankbag.app` and leaves the running `routeloop.app` stack orphaned beside it. Two things fail to follow on their own:

- `./data/storage`, holding every imported KML and GPX, is a bind mount under the old deploy directory.
- The `db-data` volume is namespaced by the Compose project name, which Compose derives from the deploy directory. A plain `mv` of the directory changes that name, so the database does **not** come with it.

The prod database was empty at cutover and may still be; stage may not be. Check before assuming. The order that works, per environment, with the stack stopped:

```bash
# 1. Back up first — this is the only step that cannot be redone later.
./utils/deploy/deploy-utils.sh db-dump          # writes a local .sql.gz

# 2. On the NAS: stop the old stack and move the directory (carries ./data/storage).
ssh -p 33725 ziad@nas.feralcreative.co
cd /volume1/web/routeloop.app && /usr/local/bin/docker compose down
mv /volume1/web/routeloop.app /volume1/web/tankbag.app

# 3. Deploy. This creates tankbag* containers and a fresh, empty db-data volume,
#    then the post-deploy hook applies the schema.
./utils/deploy/prod.sh

# 4. Restore the dump if step 1 found any data. The dump names the old role, so
#    rewrite it — POSTGRES_USER is 'tankbag' now.
gunzip -c dump.sql.gz | sed 's/\brouteloop\b/tankbag/g' \
  | /usr/local/bin/docker exec -i tankbag-db psql -U tankbag -d tankbag
```

The old `routeloopapp_db-data` volume is left in place deliberately—do not prune it until the new stack is verified. No tunnel or DNS change is needed: all four hostnames already route to these containers.

The container runs as the host uid (`APP_UID`/`APP_GID` in `deploy.config`) because the Synology ACL grants nothing to uid 1000. The symptom if that regresses: a working ride list with silently 404-ing route files.

## Conventions

- **Never commit, push, or deploy without explicit permission.** Hand over a commit message instead. No AI co-author attribution, ever.
- SCSS compiles with `npm run sass`, never an IDE extension.
- Utility scripts in `utils/`; docs other than the README and primer in `docs/`; plans in `_PLANS/`.
- Markdown: fenced blocks need a language, no `---` rules, blank lines around headings, lists and code, prose is never hard-wrapped, and em dashes in prose are tight.
