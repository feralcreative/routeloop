# Status and handoff

**Updated:** 2026-08-15
**Branch:** `feat/builder-panel`, seven commits ahead of `main`, none pushed—869 tests across 37 files
**Closes, since the last update:** epic #88 entire—#39, #89, #90, #91, #92, #93, #94, #95, #96, #97, #98—plus #104's route rename
**For:** the next agent, or the owner returning cold

**One schema change is in this branch and it has been applied to the local dev database only.** `drizzle/0002_keen_sasquatch.sql` adds `user_profiles.duration_format`. It is additive—a new enum type and one column with a default—so it needs no backfill and rewrites no table, but stage and production have not seen it and the deploy is the thing that applies it.

Read [AGENTS.md](../AGENTS.md) for the operating rules, then this for where things actually stand. This document is the one that gets stale fastest; if it disagrees with the code, the code is right.

## The builder panel redesign—epic #88, all five phases, 2026-08-15

Nothing in this section is deployed. It is all local on `feat/builder-panel`.

The panel is the app's primary work surface and had never been designed as one—it grew a control at a time. A measured pass on 2026-08-10 against `/builder/9` found **380px wide holding 198 interactive elements, with 807px of content in a 620px window** on a 3-day ride with 7 stops on the focused day. That measurement became [ROADMAP](ROADMAP.md) item 16 and then epic [#88](https://github.com/feralcreative/routeloop/issues/88). Re-measured on the same ride, the same day and the same viewport after four phases: **380px, 180 elements, 618px of content in a 617px window**—the seven-stop day fits without scrolling, where it used to overflow by 187px. The width is unchanged on purpose; it was never the complaint.

**The governing rule the whole epic runs on: nothing in the panel changes size as its value changes.** Reserve the space, fix the footprint, let the content fit the box. Every fixed width and `min-height` that looks arbitrary in `_builder.scss` is that rule—`.save-status` at 15ch, `.row-roles-btn` square, `.day-times-note` reserving a line it is often not using. Do not "clean up" one of them without knowing which readout it is holding still.

Phase by phase, and what to know about each:

1. **Autosave, and the Save button is gone** (#89, #90). Two timers, not one: a 3s idle debounce and a **20s ceiling** armed on the first edit of a dirty run. The ceiling is the one that matters—an idle debounce alone has no upper bound, so dragging a stop around for four minutes never goes idle and never saves. The route request keeps its own separate debounce in `computeLeg()`; that is the half that costs money and it is deliberately not coupled to this. Discard went with Save; undo/redo replaces it.
2. **The ride's name is the headline, and the panel has a way out** (#94, #91). The field **is** the heading rather than something a pencil reveals—a reveal would be a second mode and a layout jump. Half of #91 turned out to be wrong: the existing control was never an X, it is a minimize glyph, so collapse did not have to move. What was real was that there was **no exit at all** from a map page except the nav hamburger. There are two controls for two verbs now, on the viewer as well.
3. **The row** (#98, #97, #92, #39). Six buttons became two, a drag tab and a `⋯`. Role icons hold one icon's footprint whatever the role count. **The index mapping was the whole job of drag-to-reorder**: `orderedRows()` interleaves stops and POIs by distance along the track while each row's `data-i` indexes its own array, so Sortable's `oldIndex`/`newIndex` mean nothing—reading the DOM order of the stop rows and taking their `data-i` sidesteps the interleaving. A POI drags too, and dragging one **moves its pin** rather than reordering it, because a POI's place is projected and not stored.
4. **The timeline left the panel** (#93). It is a bar across the bottom edge of the map now, on both pages—see the next section.
5. **Stop durations are a preference** (#96). The last one, the smallest, and the only one with a schema change—see the section below that.

The epic is closed. What it did not do, deliberately: the panel is still 380px wide, because the width was never the complaint.

### The ride timeline moved to the map's bottom edge

`rideTimeline()` in [layout.tsx](../src/views/layout.tsx) renders it once and both map shells drop it into the page body **beside** `#info-panel` rather than inside it. Five things worth knowing before touching it:

- **It is not a mode split.** The open question on the roadmap assumed the two sliders had to become a view mode and an edit mode, which would have put the timeline out of reach while planning—a change to a stated headline feature. Wrong axis: the day scrubber picks what you are **editing** and the timeline moves through what you are **looking at**, so they separated by place. The scrubber stayed in the panel.
- **The move cost almost no JS** because both clients reach `#time-slider` and `#time-readout` by `getElementById` and neither walks up from them. Keep it that way.
- **It hides now rather than going inert.** In the panel it stayed put and went disabled, because vanishing would have reflowed every control under it. Over the map there is nothing under it, so a dead slider lying across someone's route is the worse of the two. The hint it used to carry moved to `#day-times-note`, beside the Starts field that fixes it.
- **The bottom edge is not empty.** Google's wordmark and the attribution row are a **licence condition** and may not be covered; the zoom and recenter buttons own a gutter at RIGHT_BOTTOM. Both are declared as custom properties on `html.map-page` (`--map-credit-height`, `--map-control-gutter`) and the bar's offsets are calculated from them. This was caught by measuring on a phone, where the first version covered all three.
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
- **The favicon set is generated, not hand-cut.** `node utils/build-favicons.mjs` renders all eight files in `public/img/favicon/` from `_assets/favicon.svg` through `rsvg-convert`. The `.ico` is assembled in that script from PNG payloads, so the repo needs no icon encoder for it.
- **The mark inside the 1000×1000 favicon canvas is only 1000×502**, with transparent bands top and bottom. So the manifest's own icons are `purpose: "any"`, and a separate opaque `maskable-*` pair on `#ffdd00` carries the 80% safe zone Android wants. Declaring the transparent, letterboxed icon `any maskable`—which it did—crops a launcher straight into the loop.
- **`public/site.webmanifest` and the repo-root `site.webmanifest` are gone.** Neither was linked from anywhere, they disagreed with each other on name and theme color, and the root one pointed at paths that do not exist. `public/img/site.webmanifest` is the one `siteIconLinks()` serves.

Two things to know before redrawing any of it. The email PNGs are **opaque by design**—both are currently 800×100 with zero non-opaque pixels, and `test/email-dark-mode.test.ts` reads their corner pixels to keep it that way. And `_assets/` is the source of record—the same test asserts the served copy in `public/img/` is byte-identical, so updating one without the other ships nothing.

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

1. **The Maps browser key referrer list** still carries only the tankbag hosts. It must gain the routeloop ones _before_ the flip or the key is blocked on its own site—`RefererNotAllowedMapError`, a map that never draws while the rest of the page looks fine. Same for the OAuth redirect URIs.
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
4. ~~**The repo directory** is still `/Users/ziad/www/moto/routeloop`.~~ **Renamed 2026-07-30** to `/Users/ziad/www/moto/tankbag`. The `cd` paths in this document were updated to match; older `_PLANS/` files and shell history still point at the old path.
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

**The NAS and the workstation share one egress IP, `69.209.26.137`.** They are on the same residential line. That is convenient now and is exactly the fragility to watch: an ISP lease change silently breaks server-side Routes and Geocoding while the browser key keeps working, so it presents as a routing bug rather than a credentials one.

### Re-verifying the keys

Run this when routing starts failing for no visible reason, or after any change in the Cloud console. It is the same check used when the restrictions were applied. The first line must report BLOCKED—if it reports ALLOWED, the key is open again.

Both domains are listed on purpose and both must now report ALLOWED—confirmed 2026-07-29 after the allow-list was updated. `evil.example.com` must report BLOCKED in every case.

```bash
cd /Users/ziad/www/moto/tankbag
KEY=$(grep -E '^GMAPS_KEY=' .env | cut -d= -f2-)
for ref in "https://evil.example.com/" "https://tankbag.app/" "https://routeloop.app/" "http://localhost:6686/"; do
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

This is defence in depth rather than a live hole—both keys are API-restricted, so none of the 23 was reachable. It matters because **the browser key's referrer restriction was silently lost once already** during the project migration (see the `API_KEY_HTTP_REFERRER_BLOCKED` note above). Disabling shrinks what a repeat would expose.

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

**Most of the time model was already built.** `routes.start_at` / `end_at` exist, [rides.ts](../src/routes/rides.ts) already validates, persists and returns them, and builder state already carried them through `newRoute()`, `payload()` and `loadExisting()`. Nothing wrote them. So the first commit's worth of work was UI on a finished pipe, not plumbing.

**Four decisions, settled with the owner and worth not relitigating:**

1. **`routes.duration_s` stays riding-only.** It is already cached on saved rows and read in two places that expect that meaning. The end time is derived as start + riding + stop dwell at the point of use instead. Note the two columns already disagreed before this work: `rideTotals` counts dwell in the ride-level total, `routes.duration_s` does not.
2. **A new day seeds its start at 08:00 the following morning**, not at the previous day's end instant—which would put day 2 starting at 6pm in a hotel lobby.
3. **Times take the builder's own timezone.** `datetime-local` carries none, so a ride planned in California reads back in California time even for its Nevada legs. A per-ride timezone is the real fix and is deliberately a separate issue.
4. **The timeline does not replace the day slider.** Both write one shared focus model. The day slider also decides where new stops land, and removing it would moot #19.

**`b1e9188`—unrouted legs no longer count as zero time.** `straightLeg` still stores `durationS: 0`, because fabricating a number there would persist as though the router had returned it. Instead a leg with zero duration and non-zero distance is treated as unrouted and estimated from distance at 20 m/s (the figure `utils/seed-demo-rides.ts` already uses). That derivation survives a save/reload with no schema change, where a client-side flag would not—zod strips unknown keys, so an extra field on a leg is silently dropped on save. Anything built on it is labelled: totals prefix the riding figure with `~`.

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

**#19 (`e859d6e`) contradicted a comment on purpose.** The old note argued even tick spacing was deliberate because the thumb inset made alignment impossible. Wrong twice: the inset is knowable (a thumb centre travels between half a thumb from each end, so the usable track is `100% - thumb`), and `space-between` was aligning label _edges_, not centres, which drifted further off than the inset ever did. Measured in Chrome at 320px: centres now land within 0.01px of the computed thumb positions, against 4.18px before.

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

**Moving the pin does not fix it, and this is the part that is easy to get wrong.** The first leg is _drawn_ from the house: the line points at the building whatever the marker says. Relabelling or nudging the marker leaves the geometry intact. The substitution has to happen while planning, and leg 0 has to re-route.

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

- **It is deliberately not verified against a router.** The tempting design—ask the router for A→B, diff it against the intended line, insert a point wherever they disagree—is close to tautological, because `route_legs.geometry` _is_ Routes API output; it agrees, and costs dozens of calls to discover that. It also defends against the wrong router. The one that ruins a ride is never ours: it is the rider's own Google Maps carrying their avoid settings, or a Garmin recomputing after a missed turn. You cannot verify against a router you do not control, so the only defence is leaving it no room—and density is geometry, free and offline.
- **Turns first, then the longest unpinned runs.** A junction taken left is a junction a router could take straight through, so candidates are scored by heading change—the same signal `twist.ts` uses, asked a different question. Whatever budget the turns do not want goes to halving the widest gaps, because curvature cannot see a parallel frontage road and only proximity defends against one.

**`src/maps/gmaps-links.ts`** serializes a day into an ordered series of `/maps/dir/?api=1` links. **Google Maps carries 9 waypoints per link**, established on a real iPhone rather than from the documentation—the "~10 points" figure in older docs was an assumption, and Google's own docs are wrong about the part that matters, since their three-waypoint figure applies to a route rendered in the mobile browser and not to the app the link hands off to. Omitting `origin` makes Maps use the rider's current location and offer **Start** rather than Preview, which removes the "add Your Location and drag it to the top" ritual riders otherwise perform at every fuel stop. Consecutive links deliberately **share** a point: a clean partition would leave the leg between two batches unnavigated.

**`/m/:slug/navigate`** ([handoff.tsx](../src/routes/handoff.tsx)) is the page, on the same visibility gate as the viewer, with no JavaScript beyond plain hrefs because it has to work at a fuel stop on one bar. Density is off / light / tight, labelled by what the rider is actually choosing between—room for the nav app, against how many times they stop and tap—rather than by point counts. **It states the longest unpinned stretch rather than hiding it.** Between two consecutive points Maps routes however it likes, and saying so is the difference between this and every tool that claims a clean hand-off and delivers a route that wandered.

Raw coordinates render as "dropped pin". Named places need Google place IDs, which this app does not store yet; the route is exact and navigable either way, so names are an upgrade rather than a blocker.

## Contributor scaffolding—2026-08-05

Branch `chore/contributor-onboarding`, merged in #75. `CONTRIBUTING.md`, a PR template, rewritten issue templates, and **CI** at `.github/workflows/ci.yml`—typecheck plus tests on every pull request and on pushes to `main`.

**The Node matrix is 20 and 22 on purpose:** development happens on 20 and the Dockerfile ships `node:22-alpine`, so running both is what catches the drift between them. There is no database service, because the suite is deliberately scoped to pure logic. If a test ever needs Postgres, adding a service container should be a decision taken on purpose rather than something already sitting there.

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

- **`/import` carries a collapsed `<details>`** with the annotated example, what is literal, what is optional, and one line on why the date is the field that matters. Collapsed and labelled optional on purpose: every file that ignores the convention imports exactly as it always did, and a form that opens with a naming spec reads like a requirement. It explains itself inline rather than only linking out, because sending someone off the page to learn how to name files they are already holding is how it goes unread.
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
cd /Users/ziad/www/moto/tankbag
npm install
cp .env.example .env          # see the file for what each value is for
docker compose up -d --wait db
npm run db:migrate            # generated migrations; npm run dev does this too
npx tsx src/db/seed.ts        # demo user + sample ride (needs moto-storage/1/1.kml)
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
