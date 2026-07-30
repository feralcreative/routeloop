# Status and handoff

**Updated:** 2026-07-29
**Branch:** `refactor/google-maps-and-auth`, based on `2a96dae`
**For:** the next agent, or the owner returning cold

Read [\_AI_AGENT_PRIMER.md](../_AI_AGENT_PRIMER.md) for architecture, then this for where things actually stand. This document is the one that gets stale fastest; if it disagrees with the code, the code is right.

## TL;DR

tankbag is a ride **planning / sharing / organizing** app, not navigation. It is live at `tankbag.app` on a Synology NAS behind Cloudflare Tunnel.

Two migrations are in flight on this branch:

| | Was | Is becoming | State |
| --- | --- | --- | --- |
| Auth | Cloudflare Access | Google OAuth + magic link, owned by the app | **committed** in `17de208`; needs credentials to run |
| Maps | Mapbox GL + Directions + Geocoding | Google Maps JS + Places + Routes | **started** — Phase 0 passed, routing proxy landed, engine not yet ported |

## Renamed back to tankbag, 2026-07-29

The `routeloop` name lasted five days. `tankbag.app` is canonical again, `routeloop.app` 301s to it, and the reasoning is that a tank bag is the thing with the map pocket on top—the pre-GPS object that held your route. The known cost is SEO: "tank bag" is a generic luggage category, so the name competes with Nelson-Rigg and Givi for its own search results.

Done in the repo: the canonical/legacy host map reversed, cookies (`tankbag_session`, `tankbag_oauth_state`, `tankbag_oauth_verifier`), the alpha-splash localStorage key, Postgres role and database, container/image/network names, deploy config, page titles, magic-link email copy, and eight new logo files replacing the old set. Typecheck and the SCSS build both pass.

**Not done, and none of it is scriptable from the repo:**

1. ~~**Browser Maps key referrers.**~~ **Done 2026-07-29**—the allow-list now carries the tankbag hosts alongside the routeloop ones, verified per origin. See "Console work" below.
2. **OAuth client**—not yet created, so nothing to correct. Its redirect URIs must use the tankbag hosts; the list further down is already written that way.
3. **Favicons.** `public/img/favicon.{svg,ico,png}`, `favicon-96x96.png` and `apple-touch-icon.png` are RealFaviconGenerator output carrying the **old routeloop mark**. They were not part of the new logo set and cannot be faithfully regenerated from it here—re-run the generator against the new artwork.
4. **The repo directory** is still `/Users/ziad/www/moto/routeloop`, and every absolute path in these docs points there. Renaming it is a separate step that invalidates those paths, IDE workspaces and any shell history.
5. **SonarCloud project key** in `.vscode/settings.json` is still `feralcreative_routeloop-app`. Left alone deliberately: it must match a project that actually exists in SonarCloud, so rename it there first. Note the GitHub repo itself was never renamed—it is still `feralcreative/tankbag-app`.
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

## Uncommitted on this branch right now

**`POST /api/route`**—[src/routes/routing.ts](../src/routes/routing.ts), new, registered in [src/index.ts](../src/index.ts). Server-side proxy to the Routes API, gated by `requireAuthApi` + `requireActiveApi` + `requireSameOrigin`. It exists because the Routes key is IP-restricted and so cannot be used from a browser. It carries a bounded in-process cache of computed legs, which matters because a rider dragging a stop re-requests the same pair constantly and Routes bills per call.

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

Nothing calls it yet. The builder still uses Mapbox Directions; pointing `directions()` in [public/js/builder.js](../public/js/builder.js) at this endpoint is the next step.

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
cd /Users/ziad/www/moto/routeloop
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
gcloud services api-keys describe a321c95b-05e3-4f11-82db-25baa39a9c55 \
  --project=routeloop-503503 --format='value(restrictions.serverKeyRestrictions.allowedIps)'
```

Note the shell quoting hazard that produced a false result the first time this was run: building the `-H "Referer: …"` argument conditionally through a variable expansion mangles the header, and every origin then reports BLOCKED—which reads as "the restriction works" when in fact nothing was sent. Pass the header literally, as above.

<!--| PAGE-BREAK -->

## Still blocked on you, in the console

Ordered by what it unblocks. Items 1 and 2 have no API and cannot be scripted.

1. **A vector Map ID** → `GMAPS_MAP_ID`, currently empty. Maps Platform → Map management → create, type **Vector**. Advanced Markers render nothing without one, failing with a console warning and no marker, which reads as a data bug. Confirmed console-only: `mapmanagement.googleapis.com` is enabled and appears in the key's API targets, but every REST path 404s and there is no `gcloud maps` command group. `DEMO_MAP_ID` works for local development and must not ship.
2. **OAuth client + consent screen** → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Scopes exactly `openid` + `email` + `profile`; anything sensitive or restricted caps the app at 100 users pending review. Authorized redirect URIs, which [src/config.ts:75](../src/config.ts#L75) builds as `${APP_ORIGIN}/auth/google/callback`:

   ```text
   http://127.0.0.1:6686/auth/google/callback
   https://stage.tankbag.app/auth/google/callback
   https://tankbag.app/auth/google/callback
   ```

3. **A Gmail app password** → `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`. On an account separate from the OAuth client, which needs 2FA enabled first.
4. **Privacy policy and terms pages.** Required fields to publish an external consent screen; neither page exists. These can be drafted in-repo whenever you want them.
5. **Per-API daily quota caps.** Google's free tiers are far smaller than Mapbox's—Dynamic Maps 10k/month against 50k, Routes 10k against Directions' 100k. A budget alert reports the money after it is gone; a quota cap prevents it.

Until 2 and 3 exist there is **no way to sign in locally**—the Access bypass is deleted and both new methods are flagged off without credentials. To test an authenticated endpoint before then, mint a session directly:

```bash
# from the repo root, with the dev DB up
npx tsx -e "import('./src/auth/session').then(async m => console.log(await m.createSession(1)))"
# then send it as: Cookie: tankbag_session=<token>
```

## Next steps, in order

1. **Port the map engine.** Rewrite the six `mapboxgl`-touching exports in [public/js/map-common.js](../public/js/map-common.js)—`initMap`, `fitTo`, `addRouteLayers`, `removeRouteLayers`/`updateRouteTrack`, `setRouteVisible`/`setRouteDim`, `attachPopup`, all between lines 16 and 127. Everything from line 129 down is pure DOM and ports unchanged. `ensureArrowImage` gets deleted outright: it draws a triangle to a canvas only because Mapbox has no line symbol, and `Polyline.icons` with `FORWARD_CLOSED_ARROW` does it natively. Read [public/js/main.js](../public/js/main.js) first—it is 1,135 lines of working `google.maps` covering this exact behavior, so much of this is an un-port.
2. **Point `directions()` at `/api/route`.** [public/js/builder.js](../public/js/builder.js)—the endpoint is built and tested; this is a small change. Its return shape already matches what the builder expects.
3. **Port [viewer.js](../public/js/viewer.js)** (three `mapboxgl` references, all through `TBMap`) then swap the shells in [src/index.ts](../src/index.ts) and `MAPBOX_CSS_LINK` in [src/views/layout.ts](../src/views/layout.ts).
4. **Move `profile.js` geocoding** to a server proxy alongside `/api/route`, since Geocoding is on the server key.
5. **Phase 4—retire Mapbox.** Delete `main.js`, collapse `viewHtml`/`nativeViewHtml` into one, drop `MAPBOX_TOKEN` and `MAPBOX_GL_VERSION` from config, `.env.example`, `docker-compose.prod.yml` and the deploy guard in `utils/deploy/deploy.sh`.

Do not start step 1 in fragments. A half-ported engine leaves the branch unable to render anything, and the Mapbox path currently works.

<!--| PAGE-BREAK -->

## Known risks

- **Coordinate order** stays the likeliest bug. Mapbox is `[lng, lat]`, Google is `{lat, lng}`, and `route_legs.geometry` stores Mapbox order. Getting it backwards still renders, just in the wrong place. Confirmed good news: Routes API with `polylineEncoding: GEO_JSON_LINESTRING` returns `[lng, lat]`, so **no stored ride needs migrating**. `toGoogleWaypoint` in [src/routes/routing.ts](../src/routes/routing.ts) is the only place the routing path reorders a pair; keep it that way in the engine port.
- **The Mapbox token is still unrestricted** and billable to that account until Mapbox is gone.
- **The shared residential egress IP**—see above. Both environments and the workstation ride on one address.
- **Gmail sending caps** at roughly 2,000 recipients/day on Workspace, 500 on a consumer account. Fine for an alpha, a wall later.
- **Schema is push-only.** No `drizzle/` directory, no generated migrations. Run `npx drizzle-kit push` without `--force` and read the statement list first—riders now hold data that cannot be rebuilt from an uploaded file.
- **Deploy the new auth code before removing the Cloudflare Access policy.** In the window between pulling the policy and shipping the code that stops trusting the injected header, the deployed build is wide open. The order is not a preference.

## Local development

```bash
cd /Users/ziad/www/moto/routeloop
npm install
cp .env.example .env          # see the file for what each value is for
docker compose up -d --wait db
npx drizzle-kit push
npx tsx src/db/seed.ts        # demo user + sample ride
npm run dev                   # http://localhost:6686
```

Port 6686 is this project's port—kill and reuse it, never switch.

- There is a shared tmux session named `shared`; the dev server runs in its own window. Backgrounding it in the main window gets it **suspended on tty input**, where it holds the port and answers nothing. Two such zombies were found and cleared on 2026-07-27, in state `TN`. If requests hang with the port bound, that is the cause—`kill -CONT` then `kill -9`, since SIGTERM never reaches a stopped process.
- Browse at `localhost`, not `127.0.0.1`, while Mapbox is still in place. `isAllowedOrigin` accepts both, so CSRF passes either way.
- `public/style/main.min.css` is a gitignored build artifact—`npm run sass`.
- `.prettierrc`: width 120, single quotes and no semicolons for `src/`, with overrides so `public/js` keeps its double quotes and semicolons.

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
