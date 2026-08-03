# Status and handoff

**Updated:** 2026-08-02
**Branch:** `fix/editor-interface-sizing`, based on `origin/main`—nine commits
**Note:** the public-surfaces work merged as PR #47. A local `main` that has not been pulled since will make `git log main..HEAD` look like it carries two sprints. Pull first.
**For:** the next agent, or the owner returning cold

Read [\_AI_AGENT_PRIMER.md](../_AI_AGENT_PRIMER.md) for architecture, then this for where things actually stand. This document is the one that gets stale fastest; if it disagrees with the code, the code is right.

## TL;DR

tankbag is a ride **planning / sharing / organizing** app, not navigation. It is live at `tankbag.app` on a Synology NAS behind Cloudflare Tunnel.

Two migrations drove the previous branch, `refactor/google-maps-and-auth`, which is now merged into `main`:

| | Was | Is becoming | State |
| --- | --- | --- | --- |
| Auth | Cloudflare Access | Google OAuth + magic link, owned by the app | **working locally**—credentials in place (2026-07-30); both methods verified. Still needs a prod deploy + the Access-policy removal, in that order |
| Maps | Mapbox GL + Directions + Geocoding | Google Maps JS + Places + Routes | **Done.** Builder, viewer, search and geocoding all run on Google; `main.js` and every `MAPBOX_*` value are gone. Verified against the code 2026-08-02, because this row claimed otherwise for a day after it stopped being true |

## Renamed back to tankbag, 2026-07-29

The `routeloop` name lasted five days. `tankbag.app` is canonical again, `routeloop.app` 301s to it, and the reasoning is that a tank bag is the thing with the map pocket on top—the pre-GPS object that held your route. The known cost is SEO: "tank bag" is a generic luggage category, so the name competes with Nelson-Rigg and Givi for its own search results.

Done in the repo: the canonical/legacy host map reversed, cookies (`tankbag_session`, `tankbag_oauth_state`, `tankbag_oauth_verifier`), the alpha-splash localStorage key, Postgres role and database, container/image/network names, deploy config, page titles, magic-link email copy, and eight new logo files replacing the old set. Typecheck and the SCSS build both pass.

**Not done, and none of it is scriptable from the repo:**

1. ~~**Browser Maps key referrers.**~~ **Done 2026-07-29**—the allow-list now carries the tankbag hosts alongside the routeloop ones, verified per origin. See "Console work" below.
2. ~~**OAuth client.**~~ **Done 2026-07-30**—created on the tankbag GCP project with an External consent screen and the three tankbag redirect URIs. See "Google Cloud migrated to the tankbag project" below.
3. ~~**Favicons.**~~ **Done 2026-07-31**—regenerated from the current mark and moved into `public/img/favicon/` in `22610b8`. This entry described them as stale, at paths that no longer existed, for longer than it was true; an issue got filed off it on 2026-08-01 for work already finished. If a checklist item here is about assets, look at the files before believing it.
4. ~~**The repo directory** is still `/Users/ziad/www/moto/routeloop`.~~ **Renamed 2026-07-30** to `/Users/ziad/www/moto/tankbag`. The `cd` paths in this document were updated to match; older `_PLANS/` files and shell history still point at the old path.
5. **SonarCloud project key** in `.vscode/settings.json` is still `feralcreative_routeloop-app`. Left alone deliberately: it must match a project that actually exists in SonarCloud, so rename it there first. The GitHub repo *was* renamed on 2026-07-30—it is `feralcreative/tankbag` now, and the local remote was re-pointed at it the same day. The old `feralcreative/tankbag-app` URL still works only through GitHub's rename redirect, so anything still hardcoding it is living on borrowed time.
6. **`_PLANS/` history was left untouched.** `chat-with-sol.md` in particular is a transcript of the *previous* rename; rewriting it would turn a record of what happened into fiction.

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

| Mapbox | Google |
| --- | --- |
| `mapboxgl.Map` + `NavigationControl` | `Maps.Map` with `mapId`, `zoomControl` bottom-right |
| `LngLatBounds` + `fitBounds(maxZoom)` | `LatLngBounds`; **no** maxZoom option, so a one-off `idle` listener clamps it |
| `addSource` / `addLayer` line + symbol | one `Polyline` per route, held in a `WeakMap` keyed by map |
| `ensureArrowImage` (canvas triangle) | **deleted**—`Polyline.icons` + `FORWARD_CLOSED_ARROW` |
| `mapboxgl.Marker({element})` | `AdvancedMarkerElement({content})` |
| `mapboxgl.Popup` | `InfoWindow` with `headerDisabled` |
| Geocoding v6 forward | Places `AutocompleteSuggestion` + session tokens |
| `map.on('load')` | nothing—the map is usable when the constructor resolves |

**Three things worth knowing before you touch it again:**

- **`.tb-marker` is deliberately `0×0`** ([style/\_map.scss](../style/_map.scss)). An `AdvancedMarkerElement` anchors its content at the content's *bottom-center*; a zero-size box puts that anchor exactly on the point, so the legacy negative-margin offsets keep working. Size that wrapper to its contents and every marker drifts up and to the right of its own coordinates.
- **Coordinate order stays confined to `toLatLng` / `fromLatLng`.** Same discipline as `toGoogleWaypoint` in [routing.ts](../src/routes/routing.ts). Verified live: a leg round-trips as `[-117.022799, 34.895831]`, lng first.
- **Search had to move too.** It was not scope creep: each provider's terms tie their search results to their own basemap, so Mapbox Geocoding drawn on a Google map breaks Mapbox's terms just as Places on a Mapbox map breaks Google's.

Verified in a browser with zero console messages on both pages: Places autocomplete returns split main/secondary text, picking a result adds a named stop, a second stop routes through `/api/route` and draws real road geometry with arrows, save round-trips, and the viewer renders markers, mileage tooltips, the visibility checkbox, hover-dim and the arrow toggle.

**`POST /api/route`**—[src/routes/routing.ts](../src/routes/routing.ts), registered in [src/index.tsx](../src/index.tsx). Server-side proxy to the Routes API, gated by `requireAuthApi` + `requireActiveApi` + `requireSameOrigin`. It exists because the Routes key is IP-restricted and so cannot be used from a browser. It carries a bounded in-process cache of computed legs, which matters because a rider dragging a stop re-requests the same pair constantly and Routes bills per call. The builder calls it now.

Verified end to end against the live API:

| Case | Result |
| --- | --- |
| Barstow → Victorville | 71,316 m / 3,059 s / 218 points—identical to a direct API call |
| Two via points | 200 |
| No session | 401 |
| Foreign `Origin` | 403 |
| Malformed body | 400 |
| Coordinates passed as `[lat, lng]` | 400—caught by range validation, not silently routed |
| Unroutable pair (mid-Pacific) | 422 |
| Server key present in `/`, `/builder`, `/login` source | 0 occurrences |
| Cache | 256 ms cold, 5 ms warm |

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

**When every origin reports BLOCKED, read the response body before believing the allow-list is correct.** On 2026-07-30 the browser key rejected *every* referrer including `tankbag.app`, which this document had recorded as verified hours earlier. That looks exactly like the quoting hazard above, and it was not—the body said `API_KEY_HTTP_REFERRER_BLOCKED` against `projects/976935115789`, so the restriction really had been lost between the project migration and the next test. Re-applying the allow-list fixed it. `grep -q suggestions` cannot tell "blocked" from "malformed request"; the body can:

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

**The old `routeloop-503503` keys are now orphaned but must stay alive** until the new `.env` is deployed to prod—the *live* prod build still uses them. Delete them only after the prod cutover, or the imported-ride viewer breaks in production.

Both the referrer-update command and the re-verify block now name the `tankbag` project and the live key uids, corrected 2026-08-02.

## Console hardening—done 2026-08-02

The credential items (Map ID, OAuth client, SMTP) landed 2026-07-30. Everything else that was listed here is now done too, and both items this section used to carry were **already stale when they were read**—the same rot that let issue #6 sit with seven unchecked boxes when five were finished.

### Daily quota caps, applied

Overrides on the `tankbag` project (`976935115789`), verified as overrides rather than defaults:

| metric | daily cap | previously |
| --- | --- | --- |
| `maps-backend/billable_default` (map loads) | 500 | unlimited |
| `routes/compute_routes_requests` | 500 | unlimited |
| `places/AutocompletePlacesRequest` | 500 | 175,000 |
| `places/GetPlaceRequest` | 300 | 125,000 |
| `geocoding-backend/billable_default` | 100 | unlimited |

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

## Trip timeline—done, 2026-08-01

Branch `feat/trip-timeline-slider`, ten commits, covering [issue #7](https://github.com/feralcreative/tankbag/issues/7) (ROADMAP item 2) and [issue #19](https://github.com/feralcreative/tankbag/issues/19), which is folded in because it is the same widget. The full plan is in `_PLANS/issue-7-trip-timeline.md`—local only, since `_PLANS` is gitignored as of `7d0db74`.

**Most of the time model was already built.** `routes.start_at` / `end_at` exist, [rides.ts](../src/routes/rides.ts) already validates, persists and returns them, and builder state already carried them through `newRoute()`, `payload()` and `loadExisting()`. Nothing wrote them. So the first commit's worth of work was UI on a finished pipe, not plumbing.

**Four decisions, settled with the owner and worth not relitigating:**

1. **`routes.duration_s` stays riding-only.** It is already cached on saved rows and read in two places that expect that meaning. The end time is derived as start + riding + stop dwell at the point of use instead. Note the two columns already disagreed before this work: `rideTotals` counts dwell in the ride-level total, `routes.duration_s` does not.
2. **A new day seeds its start at 08:00 the following morning**, not at the previous day's end instant—which would put day 2 starting at 6pm in a hotel lobby.
3. **Times take the builder's own timezone.** `datetime-local` carries none, so a ride planned in California reads back in California time even for its Nevada legs. A per-ride timezone is the real fix and is deliberately a separate issue.
4. **The timeline does not replace the day slider.** Both write one shared focus model. The day slider also decides where new stops land, and removing it would moot #19.

**`b1e9188`—unrouted legs no longer count as zero time.** `straightLeg` still stores `durationS: 0`, because fabricating a number there would persist as though the router had returned it. Instead a leg with zero duration and non-zero distance is treated as unrouted and estimated from distance at 20 m/s (the figure `utils/seed-demo-rides.ts` already uses). That derivation survives a save/reload with no schema change, where a client-side flag would not—zod strips unknown keys, so an extra field on a leg is silently dropped on save. Anything built on it is labelled: totals prefix the riding figure with `~`.

**`2732526`—the date-time UI.** Start and end fields per day. The end fills itself from the day and keeps up as legs and stop durations change; typing one overrides it; clearing it hands control back. A note says which of those is in play.

**The bug that shaped it, because the design reads wrong otherwise.** Manual-ness was first inferred by comparing the stored end against the derived one, with no flag—which fails the moment the day changes, since an end that *was* automatic no longer matches the new derivation and freezes as though it had been typed. The comparison is only sound at load time, when nothing has changed yet. So `inferEndManual()` runs once on load and seeds a session-only `endManual` flag that is tracked directly from then on. It is not in `payload()` and needs no column.

**Verified:** typecheck, SCSS build, and 18 assertions over the time logic, extracted from the real `builder.js` source rather than a retyped copy. That harness lives in a scratchpad, not the repo—it works by string-extracting functions, which is fine as a scratch check and a bad thing to enshrine while [#21](https://github.com/feralcreative/tankbag/issues/21) is open to set up a real runner.

**Not verified: any of it in a browser.** `/builder` is auth-gated with no dev bypass, and the running server was `npm start` rather than `npm run dev`, so it was serving pre-change code. Layout and interaction still need a real look.

**What the rest of it landed as, and the parts worth knowing before touching any of it again:**

- **`ride.json` now carries per-leg spans.** It used to concatenate every leg into one flat `track` and drop leg durations, so a client could not tell where one leg ended—mapping a moment to a leg was impossible from the public contract. Each route now also carries `legs[{ distanceM, durationS, startIndex, endIndex }]` indexing into that same unchanged `track`.
- **That concat drops *any* consecutive duplicate, not only the joints between legs.** `sample-route-one` carries 33 repeats inside a single leg. Harmless when the output was one flat line; load-bearing now that indices point into it.
- **Consecutive legs do not always share a joint.** Real routes produce both—one demo ride shares its joints, another has a one-point gap between its first two legs. **Never test `legs[i].startIndex === legs[i-1].endIndex`**; it fails on real data.
- **`map-common.js` gained a leg highlight** as one spare `Polyline` per map, sliced from the route's own line. Additive on purpose: a `Polyline` per leg would have changed the layer-id contract every caller depends on, in a file #6, #8 and #9 also touch. Three engine paths drop a live highlight—`removeRouteLayers`, `updateRouteTrack` (which fires on every leg recompute in the builder) and `setRouteVisible(false)`—and callers re-apply. A highlight that briefly vanishes is a far smaller lie than one drawn over the wrong road.
- **The time model lives in `public/js/ride-time.js` (`window.TBTime`), shared by both clients.** Not copied into each: the builder resolves a moment from legs held in memory, the viewer from legs `ride.json` sends, and the same ride must land on the same leg in both. This is the lesson `map-common.js` already records about marker construction.
- **A moment at a stop is on no leg, and the overnight gap between days belongs to no day.** Both say so rather than lighting the leg just ridden. The readout carries the difference in words, so the map is never the only explanation.
- **The builder keeps two controls over one model.** `state.moment` is the source of truth when set; the day slider does not compete with the timeline, it *picks a moment* (that day's start). A null moment falls back to plain day focus, which is what an undated ride uses throughout.
- **In the viewer, hover outranks the timeline while it lasts.** Both wanted to dim, and before this, leaving a hovered legend row called `highlight(null)` and silently discarded the timeline's state. Both now resolve through one `paintFocus()`.

**#19 (`e859d6e`) contradicted a comment on purpose.** The old note argued even tick spacing was deliberate because the thumb inset made alignment impossible. Wrong twice: the inset is knowable (a thumb centre travels between half a thumb from each end, so the usable track is `100% - thumb`), and `space-between` was aligning label *edges*, not centres, which drifted further off than the inset ever did. Measured in Chrome at 320px: centres now land within 0.01px of the computed thumb positions, against 4.18px before.

**Verification.** Typecheck, the SCSS build, and five scratch suites covering the shared time model, the builder's date handling and leg spans, the highlight overlay, and the server's span computation—including one that runs the real server loop against the real builder function to prove they agree. A database-backed check asserted the span invariants over every ride present at the time (21 routes / 71 legs / 16 rides). The viewer was driven in Chrome; the builder was checked by the owner. **None of the scratch suites are in the repo**—they work by string-extracting functions out of source, which is fine as a scratch check and a bad thing to enshrine while [#21](https://github.com/feralcreative/tankbag/issues/21) is open to set up a real runner.

**#27 overlaps and was deliberately left out.** The leg-plus-dwell duration formula landed here, so what remains of that issue is the configurable rest cadence—which needs its own storage decision and a call on whether a generated rest break becomes a real `points` row or a display-only overlay.

On #19: the even tick spacing is deliberate, not an oversight—the comment in [\_builder.scss](../style/_builder.scss) argues the thumb inset makes exact alignment a lie at any width. It is achievable if the thumb width is pinned in CSS rather than left to the UA, but that comment needs replacing rather than quietly contradicting.

<!--| PAGE-BREAK -->

## Sprint 4: UX and the naming model—2026-08-01

Branch `style/ui-tweaks-and-cleanup`, nine commits, from `_PLANS/sprint-04-260801T2122Z.md`. Five commits are splash-page styling; four change how a rider gets named.

### The point of the naming work

**No rider's real name is adopted from Google and shown anywhere they did not choose.** That is the whole intent, and the code carries it in comments because the code alone will not survive a well-meaning edit:

- **`name` is gone from `GoogleClaims`** ([google.ts](../src/auth/google.ts)) and must not come back. It used to flow straight into `users.display_name`, which is what the nav, the dashboard greeting and the admin rider list all render—so signing in with Google silently published whatever Google held.
- **`picture` was never added, for the same reason.** Note `users.avatar_url` exists and is never written, which makes wiring that claim to it look like finishing an unfinished job rather than opening a hole. The comment on the type says so.
- **`given_name` / `family_name` *are* read**, and go to `user_profiles.first_name` / `last_name`. The distinction is where they surface: that table exists precisely so private fields never ride along on a row reaching a client, and nothing renders them to anyone but the rider. `share_last_name` is written but has **no reader anywhere in the app**.
- **What makes that acceptable rather than merely currently-harmless** is that the profile form shows both names as ordinary inputs directly above the toggle that would expose the last name, so a rider flipping it can see what it reveals. Move those fields somewhere less visible and the seeding stops being defensible. That reasoning is in [identity.ts](../src/auth/identity.ts) next to the code.

### The model, settled after two reversals

**`username` and `display_name` stay discrete.** They were briefly going to merge, until the cost surfaced: `username` is `[a-zA-Z0-9_]`, so a merged field means no spaces in the name anyone sees. `display_name` is free-form and stays what gets rendered; `username` is the handle.

**Neither is prefilled.** Both are blank and required at `/choose-name`. `display_name` is `notNull` and the row must exist before a rider can be shown anything, so `resolveUser` fills it from the email address alone and the prompt overwrites it—that placeholder is visible only in the nav, between signing in and answering.

**`users.public_id` is `{first-username}-{YYMMDDTHHMMZ}`**, e.g. `ziad-260801T2220Z`. Deliberately **not** called a UUID, because it is not one. Written once when a username is first chosen and never again, so a later change leaves every existing reference resolving. Built from explicit UTC getters: `users.created_at` is `timestamp` *without* time zone, so the `Z` is a promise the server's clock zone must not get to break.

**A released username is held for 30 days**—but never against the rider who released it, which is the entire feature. `username_history` records every name held; `uq_username_lower` stays the hard guard, since "unavailable unless you are the one who let it go" is not something an index can express. The hold is therefore an application check and the unique-violation catch is still the real backstop.

**Everything about usernames lives in [auth/username.ts](../src/auth/username.ts)**—reserved list, schema, availability, `publicIdFor`, `claimUsername`. Two callers now (the prompt and the profile form) and they must not drift.

### Read this before the next `drizzle-kit push`

Adding a nullable column and a table sounds harmless. The push offered to destroy the users table to do it:

```text
· You're about to add users_public_id_unique unique constraint to the table,
  which contains 4 items. If this statement fails, you will receive an error
  from the database. Do you want to truncate users table?
```

**`--force` auto-answers prompts like that.** It would have wiped every account to make room for a constraint that did not need it—existing `public_id` was NULL everywhere, and NULLs never collide in a unique constraint. The correct answer is no.

The DDL was applied by hand in a transaction instead, matching drizzle's own naming, and a follow-up `push` reported no changes, which is how you confirm the names line up. Do that rather than gambling on a prompt default you cannot see in a non-TTY.

### What a returning rider will hit

Existing accounts created before this sprint have `username = NULL`. `requireActive` and `requireManageRiders` now redirect those to `/choose-name`, so **every current account gets the prompt on its next visit**. That is intended, not a migration gap—there is no sensible name to invent for them, which is the point.

`/choose-name` and `/logout` run on `requireAuth` rather than `requireActive`, which is what keeps the gate from looping.

### Left undone, deliberately

The **"Sign out" link on the holding page** is `$url` blue directly over the video: 2.94:1 against bright gravel, 2.33:1 against dark foliage. Both fail WCAG AA. It is a form submit styled as a link and genuinely a lighter action than the three resource buttons beside it, so it should not become a fourth button—but it does need a colour that survives the footage. One line, not done.

## Public surfaces—2026-08-01

Branch `feat/legal-and-faq-pages`, eight commits. Closes [#45](https://github.com/feralcreative/tankbag/issues/45), [#14](https://github.com/feralcreative/tankbag/issues/14) and [#26](https://github.com/feralcreative/tankbag/issues/26); takes half of [#12](https://github.com/feralcreative/tankbag/issues/12) and the two pages [#18](https://github.com/feralcreative/tankbag/issues/18) wanted.

### The home-address exposure—read this before touching ride starts

A rider with `add_home_to_rides` on gets a first stop seeded at their house, named **"Home"**, carrying the `home` role, at six-decimal precision. `ride.json` sends `lat`/`lng`/`name`/`roles` to anyone with a share link. **Sharing such a ride publishes a map pin on your front door.**

**Moving the pin does not fix it, and this is the part that is easy to get wrong.** The first leg is *drawn* from the house: the line points at the building whatever the marker says. Relabelling or nudging the marker leaves the geometry intact. The substitution has to happen while planning, and leg 0 has to re-route.

So `user_profiles` gained a second address—`start_label`, `start_address_line`, `start_city`, `start_state`, `start_postal_code`, `start_lat`, `start_lng`—mirroring the home block field for field. When a ride whose first stop carries the `home` role is switched to public or unlisted, the builder **offers** the swap, then rewrites the stop, drops the `home` role, clears shaping points and recomputes leg 0. Offered rather than applied: the rider may have meant to share it, and silently redrawing a planned route is worse than asking. Declining is remembered for the session.

The profile copy pushes a gas station, coffee shop or trailhead—somewhere you could actually meet people.

**Still open:** rides already shared are unchanged. This only helps from the next visibility change onward.

### What is public, stated once

Every public surface reads the same rule. It is written out in `pages.ts` so it is not reconstructed per template:

| | |
| --- | --- |
| shown | username, display name, public rides |
| opt-in | last name, and only via `share_last_name` |
| never | first name, email, home address, coordinates, payment handles |

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

### Left for you

- **Favicons** still carry the old routeloop mark, including the `og:image` social card. Needs the generator and the source artwork, so it is not scriptable from the repo. Filed separately rather than holding this branch.
- **Remove the Cloudflare Access policy** at the edge. The app has ignored its header since `17de208`.
- **Set per-API daily quota caps** on the GCP project. Google's free tiers are far smaller than Mapbox's—Dynamic Maps 10k/month against 50k, Routes 10k against Directions' 100k.

## Sprint 07: the editing panel, and twistiness—2026-08-02

Branch `fix/editor-interface-sizing`. All eleven items from `_PLANS/sprint-07-260802T1618Z.md`, seven commits, 88 tests.

### What went in

| Item | Result |
| --- | --- |
| 1 | The day slider picks the working day; "All" is a view |
| 2 | POIs interleaved by distance, and they carry a duration |
| 3, 7 | Panel grouped into ride / trip / day bands, day icons tinted its colour |
| 4, 5 | Time stopped replaced by **twistiness**, with an FAQ entry |
| 6 | Panel terms link to their FAQ answers |
| 8 | Nav's last four items folded into an About submenu |
| 9 | FAQ is an accordion with stable anchors |
| 10, 11 | Bio years computed at render; tagline removed |

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

A POI is not a routing anchor, so a pause at one falls *inside* a leg rather than between two of them. The old `activeAt` alternated stop-dwell and leg-riding and had nowhere to put that. `routeSchedule()` in [ride-time.js](../public/js/ride-time.js) emits the day as a list of segments instead, which is both expressible and testable—the suite now asserts that the schedule's total always equals `routeElapsedS` (which every stored end time and the timeline slider depend on) and that it never emits a gap or an overlap.

### Three bugs the work surfaced

1. **The twistiness cache was already broken when it shipped.** It keyed on the `route.legs` array identity, but the builder mutates in place—`route.legs[i] = leg` on a reroute, `legs.splice()` on a delete—so identity never changes and it would have served pre-reroute figures forever. Both caches use content signatures now.
2. **`/api/rides/:id` did not return POI `durationMin`**, so a saved dwell would have vanished on the next load. Caught by round-tripping through the API rather than by reading the code.
3. **The clone path dropped it too**, caught by `tsc` when the payload type gained the field. Cloning would have quietly shortened every day.

### Left for you

- **Favicons** still carry the old routeloop mark, including the `og:image` card. Needs the generator and the source artwork.
- **The twistiness bands need real rides.** They are calibrated on machine-generated demo rides across California, not rides anyone chose for being good, so real trips will skew twistier. One exported const in [twist.ts](../src/maps/twist.ts).

<!--| PAGE-BREAK -->

## Next steps, in order

**The Mapbox track that used to live here is finished** and its steps were removed on 2026-08-02 because they described work already done. Checked against the code rather than taken on trust: `public/js/main.js` does not exist, `nativeViewHtml` is gone and `viewHtml` is the only shell, no `MAPBOX_*` value is read anywhere (only historical comments remain), and `profile.js` geocoding already goes through `POST /api/geocode`. If you find a claim in this file that the code disagrees with, the code is right—that is what happened here, and it had already caused one bogus GitHub issue to be filed.

What is actually next:

1. **Sprint 08, written up in `_PLANS/sprint-08-260802T1929Z.md`.** Get the HTML out of the TypeScript. Part 1 moves the 412 lines of static prose in `pages.ts` into `src/content/*.html` and stands alone; Part 2 is the optional JSX conversion of the dynamic views.
2. **Set per-API daily quota caps** on the GCP project. Google's free tiers are far smaller than Mapbox's were—Dynamic Maps 10k/month against 50k, Routes 10k against Directions' 100k.
3. **Remove the Cloudflare Access policy** at the edge. The app has ignored its header since `17de208`.

<!--| PAGE-BREAK -->

## Known risks

- **Coordinate order** stays the likeliest bug. The app stores and speaks `[lng, lat]`; google.maps speaks `{lat, lng}`. Getting it backwards still renders, just in the wrong place. Routes API with `polylineEncoding: GEO_JSON_LINESTRING` returns `[lng, lat]`, so **no stored ride ever needed migrating**. Two functions do the conversion and only two: `toGoogleWaypoint` in [src/routes/routing.ts](../src/routes/routing.ts) on the server, and `toLatLng`/`fromLatLng` in [public/js/map-common.js](../public/js/map-common.js) on the client. Keep it that way.
- **The Mapbox token is still unrestricted** and billable to that account until `profile.js` moves and Mapbox is gone.
- **The shared residential egress IP**—see above. Both environments and the workstation ride on one address.
- **Gmail sending caps** at roughly 2,000 recipients/day on Workspace, 500 on a consumer account. Fine for an alpha, a wall later.
- **Schema is push-only, and `--force` is genuinely dangerous.** No `drizzle/` directory, no generated migrations. Run `npx drizzle-kit push` without `--force` and read the statement list first—riders now hold data that cannot be rebuilt from an uploaded file. This is not theoretical: adding a nullable column plus a unique constraint on 2026-08-01 produced a prompt offering to **truncate the users table**, which `--force` would have accepted. See the sprint 4 section for what to do instead.
- **Deploy the new auth code before removing the Cloudflare Access policy.** In the window between pulling the policy and shipping the code that stops trusting the injected header, the deployed build is wide open. The order is not a preference.
- **DNS is not the blocker; the un-deployed rename is.** All tankbag hostnames already resolve through the tunnel. As of 2026-07-30 the *live* prod build predates the rename, so `tankbag.app` still 301s to `routeloop.app`—the correct routeloop→tankbag redirect lands only on the next deploy, not via any DNS change. **One real gap:** `www.tankbag.app` has **no DNS record** (`www.routeloop.app` does); add a proxied CNAME to the same tunnel, or the browser key's `www.tankbag.app` referrer entry is moot and the host won't resolve.

## Local development

```bash
cd /Users/ziad/www/moto/tankbag
npm install
cp .env.example .env          # see the file for what each value is for
docker compose up -d --wait db
npx drizzle-kit push
npx tsx src/db/seed.ts        # demo user + sample ride
npm run dev                   # http://localhost:6686
```

Port 6686 is this project's port—kill and reuse it, never switch.

**Signing in without signing in: `DEV_LOGIN_EMAIL`.** Set it in `.env` to an address that already has an account and `http://127.0.0.1:6686/dev/login` puts you straight into a session as that user. It exists because checking `/builder`, `/welcome` or a profile page otherwise means minting a session token from a script and pasting a cookie by hand, several times an hour.

The app had something like this before—`DEV_AUTH_EMAIL`, deleted along with Cloudflare Access—so this is a considered re-add rather than a restoration. It is gated four ways and when any gate fails the route is **not registered at all**, making `/dev/login` a plain 404 rather than a refusal that confirms it exists:

| Gate | Where |
| --- | --- |
| `DEV_LOGIN_EMAIL` names an existing account (it will not create one) | `config.ts`, through `env()` so a deploy's empty string counts as unset |
| `DATABASE_URL` is 127.0.0.1, localhost or host.docker.internal | `isLocalDatabaseUrl()`, shared with the seeders' `assertLocal()` |
| `APP_ORIGIN` is not https | `IS_HTTPS_ORIGIN`—the strongest gate, since stage and prod break OAuth and cookie `Secure` if they get it wrong |
| The request's `Host` is 127.0.0.1 or localhost, not the LAN address | per request, in the handler |

`utils/deploy/deploy.sh` refuses to deploy while `DEV_LOGIN_EMAIL` is set—the backstop for a dev `.env` reaching a server.

**Rebuilding the local dataset: `utils/seed-dev.sh`.** Run this rather than the two seeders by hand. `src/db/seed.ts` opens with `TRUNCATE rides, user_identities, users RESTART IDENTITY CASCADE` and, unlike `utils/seed-demo-rides.ts`, carries **no check that the database is local**—so running it straight after a `db-clone prod dev` silently destroys every account you just pulled down. The script applies that missing guard, carries the accounts across the truncate and restores them by email (identity rows are not restored and are not needed: `resolveUser` falls back to matching on email, so signing in re-links each account), and only then generates rides—`seed-demo-rides.ts` looks its owner up by email, so run in the other order every ride lands on the demo user and is invisible from the account you sign in with. `--straight` skips the Routes API, which otherwise bills one call per leg.

**`db-clone prod dev` costs you the demo data.** Prod is nearly empty; dev is where the interesting rides live. One clone took the local corpus from 16 rides / 21 routes / 71 legs to a single one-leg ride, taking `sample-route-one`—the only *imported* ride, and therefore the only local test case for the single-leg track path that Phase 4 and #6 both turn on—with it. `utils/seed-dev.sh` puts it back.

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
