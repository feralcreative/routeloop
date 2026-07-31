# Status and handoff

**Updated:** 2026-07-30
**Branch:** `refactor/google-maps-and-auth`, based on `2a96dae`, currently at `8b39424`
**For:** the next agent, or the owner returning cold

Read [\_AI_AGENT_PRIMER.md](../_AI_AGENT_PRIMER.md) for architecture, then this for where things actually stand. This document is the one that gets stale fastest; if it disagrees with the code, the code is right.

## TL;DR

tankbag is a ride **planning / sharing / organizing** app, not navigation. It is live at `tankbag.app` on a Synology NAS behind Cloudflare Tunnel.

Two migrations are in flight on this branch:

| | Was | Is becoming | State |
| --- | --- | --- | --- |
| Auth | Cloudflare Access | Google OAuth + magic link, owned by the app | **working locally** — credentials in place (2026-07-30); both methods verified. Still needs a prod deploy + the Access-policy removal, in that order |
| Maps | Mapbox GL + Directions + Geocoding | Google Maps JS + Places + Routes | **engine ported and verified in a browser (2026-07-30)**. Builder, viewer and search all run on Google. Only `profile.js` geocoding and the dead Mapbox config remain |

## Renamed back to tankbag, 2026-07-29

The `routeloop` name lasted five days. `tankbag.app` is canonical again, `routeloop.app` 301s to it, and the reasoning is that a tank bag is the thing with the map pocket on top—the pre-GPS object that held your route. The known cost is SEO: "tank bag" is a generic luggage category, so the name competes with Nelson-Rigg and Givi for its own search results.

Done in the repo: the canonical/legacy host map reversed, cookies (`tankbag_session`, `tankbag_oauth_state`, `tankbag_oauth_verifier`), the alpha-splash localStorage key, Postgres role and database, container/image/network names, deploy config, page titles, magic-link email copy, and eight new logo files replacing the old set. Typecheck and the SCSS build both pass.

**Not done, and none of it is scriptable from the repo:**

1. ~~**Browser Maps key referrers.**~~ **Done 2026-07-29**—the allow-list now carries the tankbag hosts alongside the routeloop ones, verified per origin. See "Console work" below.
2. ~~**OAuth client.**~~ **Done 2026-07-30**—created on the tankbag GCP project with an External consent screen and the three tankbag redirect URIs. See "Google Cloud migrated to the tankbag project" below.
3. **Favicons.** `public/img/favicon.{svg,ico,png}`, `favicon-96x96.png` and `apple-touch-icon.png` are RealFaviconGenerator output carrying the **old routeloop mark**. They were not part of the new logo set and cannot be faithfully regenerated from it here—re-run the generator against the new artwork. (The web manifest name was corrected to `tankbag` on 2026-07-30; the favicon *artwork* still carries the old mark.)
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

**Through `2a96dae`:** the pivot from file-upload to in-app planning (Phases 0–2), the `tankbag` → `routeloop` rename with production cutover (since reverted — see below), the unified page shell and SCSS partial split, the sign-in splash, and Sprint 2's user profiles.

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

**`POST /api/route`**—[src/routes/routing.ts](../src/routes/routing.ts), registered in [src/index.ts](../src/index.ts). Server-side proxy to the Routes API, gated by `requireAuthApi` + `requireActiveApi` + `requireSameOrigin`. It exists because the Routes key is IP-restricted and so cannot be used from a browser. It carries a bounded in-process cache of computed legs, which matters because a rider dragging a stop re-requests the same pair constantly and Routes bills per call. The builder calls it now.

Verified end to end against the live API:

| Case | Result |
| --- | --- |
| Barstow → Victorville | 71,316 m / 3,059 s / 218 points — identical to a direct API call |
| Two via points | 200 |
| No session | 401 |
| Foreign `Origin` | 403 |
| Malformed body | 400 |
| Coordinates passed as `[lat, lng]` | 400 — caught by range validation, not silently routed |
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

  ```bash
  gcloud services api-keys update 010d908a-9158-4169-b5cb-98d8f08f6b16 \
    --project=routeloop-503503 \
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

## Google Cloud migrated to the tankbag project — 2026-07-30

The Maps keys and OAuth client used to live on `routeloop-503503` (display name `routeloop`). They now live on the pre-existing **`tankbag` project (number `976935115789`)**, so the console name matches the product again. What was done, all verified:

- **Enabled five APIs** on `tankbag` (it had none of them): Maps JavaScript, Places (New), Routes, Geocoding, Map Management.
- **Browser key** → `GMAPS_KEY`. uid `53e9a638-bafb-4604-9346-282dd8c25d80`. Referrer-restricted to the tankbag + routeloop hosts and both dev origins (`127.0.0.1:6686`, `localhost:6686`), and to Maps JavaScript + Places only. Verified: `evil.example.com` BLOCKED, real hosts ALLOWED.
- **Server key** → `GMAPS_SERVER_KEY`. uid `3a3d4f70-1838-45f7-86bf-18023c32592e`. IP-restricted to `69.209.26.137`, Routes + Geocoding only. Verified against a live Routes call.
- **Vector Map ID** → `GMAPS_MAP_ID` = `a8979f770ff370036c0c516d`. Type **JavaScript / Vector**, with **tilt and rotation enabled** deliberately—riders want to see terrain relief; the map still opens flat and north-up, the 3D camera is opt-in via gesture.
- **OAuth client + External consent screen** → `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, scopes exactly `openid email profile`. Redirect URIs are the three tankbag hosts below. Verified: `/auth/google` 302s to Google with the right client, scope and PKCE.
- **Gmail app password** → `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` (`tankbag.app@gmail.com`). Verified with `transporter.verify()`.

**The old `routeloop-503503` keys are now orphaned but must stay alive** until the new `.env` is deployed to prod—the *live* prod build still uses them. Delete them only after the prod cutover, or the imported-ride viewer breaks in production.

The re-verify script above still names `routeloop-503503` and the old browser-key uid; when you next touch it, point it at the `tankbag` project and uid `53e9a638`.

## Still blocked on you, in the console

The credential items (Map ID, OAuth client, SMTP) are **done** as of 2026-07-30—see the section above. What remains:

1. **Privacy policy and terms pages.** Required to *publish* the External consent screen past its 100-user testing cap; neither page exists. Not needed for the alpha (the `users.status` gate limits real usage), but a wall once you want more than a hand-listed 100 testers. Can be drafted in-repo whenever.
2. **Per-API daily quota caps** on the `tankbag` project. Google's free tiers are far smaller than Mapbox's—Dynamic Maps 10k/month against 50k, Routes 10k against Directions' 100k. A budget alert reports the money after it is gone; a quota cap prevents it.

**Sign-in now works locally**—both Google and magic link are wired and verified. The direct-session mint below is still handy for scripting an authenticated request without a browser round-trip:

```bash
# from the repo root, with the dev DB up
npx tsx -e "import('./src/auth/session').then(async m => console.log(await m.createSession(1)))"
# then send it as: Cookie: tankbag_session=<token>
```

## Next steps, in order

Steps 1–3 (port the engine, point `directions()` at `/api/route`, port the viewer and swap the shells) landed together on 2026-07-30—see "The engine port" above. What is left:

1. **Move `profile.js` geocoding** to a server proxy alongside `/api/route`, since Geocoding is on the server key. This is the last Mapbox call in the app and the only reason `MAPBOX_TOKEN` still has to be set. It is a non-map page, so no basemap-terms conflict forced it to move with the engine.
2. **Phase 4—retire Mapbox.** Delete `main.js`, collapse `viewHtml`/`nativeViewHtml` into one, drop `MAPBOX_TOKEN` and `MAPBOX_GL_VERSION` from config, `MAPBOX_CSS_LINK` from [layout.ts](../src/views/layout.ts) (already unused), `.env.example`, `docker-compose.prod.yml` and the deploy guard in `utils/deploy/deploy.sh`.

`main.js` is still the legacy Google viewer for **imported** rides and still the only thing rendering them. Collapsing the two shells means teaching the ported engine to render an imported ride's single-leg track, which `ride.json` already serves identically for both sources—so this is smaller than it looks.

<!--| PAGE-BREAK -->

## Known risks

- **Coordinate order** stays the likeliest bug. The app stores and speaks `[lng, lat]`; google.maps speaks `{lat, lng}`. Getting it backwards still renders, just in the wrong place. Routes API with `polylineEncoding: GEO_JSON_LINESTRING` returns `[lng, lat]`, so **no stored ride ever needed migrating**. Two functions do the conversion and only two: `toGoogleWaypoint` in [src/routes/routing.ts](../src/routes/routing.ts) on the server, and `toLatLng`/`fromLatLng` in [public/js/map-common.js](../public/js/map-common.js) on the client. Keep it that way.
- **The Mapbox token is still unrestricted** and billable to that account until `profile.js` moves and Mapbox is gone.
- **The shared residential egress IP**—see above. Both environments and the workstation ride on one address.
- **Gmail sending caps** at roughly 2,000 recipients/day on Workspace, 500 on a consumer account. Fine for an alpha, a wall later.
- **Schema is push-only.** No `drizzle/` directory, no generated migrations. Run `npx drizzle-kit push` without `--force` and read the statement list first—riders now hold data that cannot be rebuilt from an uploaded file.
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

The old `routeloopapp_db-data` volume is left in place deliberately — do not prune it until the new stack is verified. No tunnel or DNS change is needed: all four hostnames already route to these containers.

The container runs as the host uid (`APP_UID`/`APP_GID` in `deploy.config`) because the Synology ACL grants nothing to uid 1000. The symptom if that regresses: a working ride list with silently 404-ing route files.

## Conventions

- **Never commit, push, or deploy without explicit permission.** Hand over a commit message instead. No AI co-author attribution, ever.
- SCSS compiles with `npm run sass`, never an IDE extension.
- Utility scripts in `utils/`; docs other than the README and primer in `docs/`; plans in `_PLANS/`.
- Markdown: fenced blocks need a language, no `---` rules, blank lines around headings, lists and code, prose is never hard-wrapped, and em dashes in prose are tight.
