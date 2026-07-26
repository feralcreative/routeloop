# Pivot Handoff — updated 2026-07-23

The precise resume point for the **route-builder pivot** specifically.
Architecture is in [../\_AI_AGENT_PRIMER.md](../_AI_AGENT_PRIMER.md); the
governing plan is
[routeloop-route-builder-pivot.md](routeloop-route-builder-pivot.md).

> **Superseded for overall project state (2026-07-24).** Work since this doc was
> written — the Cloudflare Access auth rebuild, the `tankbag` → `routeloop`
> rename, and the production cutover — is recorded in
> [../docs/STATUS.md](../docs/STATUS.md), which is now the authoritative "where
> we left off" document. The phase notes below are still accurate for Phases 0–2.

## Git state

- Branch `feat/auth`, last commit `ea08cc8` (`main` is at `d4ca68f`). **The
  entire pivot (Phases 1–2), the auth rebuild, and the rename are all
  uncommitted in the working tree.** Do not commit/push/deploy without the
  owner's explicit permission, and no AI co-author attribution.

## Done and verified

- **Phase 0 — Mapbox.** Public token is in `.env` as `MAPBOX_TOKEN`. (Account
  `feralcreative`.) It was URL-restricted to `localhost`; as of 2026-07-24 it
  answers every origin, so re-check the restrictions.
- **Phase 1 — Data model + roles + structured import.** `rides` / `routes` /
  `points` / `route_legs`; `src/maps/roles.ts`; import produces structured rows.
  Verified: schema pushed, seed + curl import populate correct rows (parsed
  roles, quota, cascade delete).
- **Phase 2 — Builder + native viewer + ride API.** Verified end to end:
  - Ride API by curl — visibility gate (200/404/owner-200), payload validation
    (400 on legs mismatch), CSRF (403 bad origin), PATCH/PUT/DELETE.
  - The Mapbox **builder** runs in a real browser (`http://localhost:6686/builder`):
    map renders, search + click add stops, per-leg Directions routing draws,
    roles/durations, save. The owner used it hands-on.
  - **Save works.** A CSRF-gate bug ("bad origin" on save) was fixed: the app is
    browsed at `localhost` but `APP_ORIGIN` is `127.0.0.1`; `isAllowedOrigin`
    now accepts both dev hosts while prod stays strict. (It lived in
    `src/auth/oauth.ts` at the time; that file was deleted in the auth rebuild
    and `isAllowedOrigin` now lives in `src/auth/access.ts`.)

## Small polish still open (quick wins)

- `public/js/builder.js` / the builder shell: add `autocomplete="off"` to the
  stop/POI `name` inputs (browser autofill can inject stray values).
- Builder form fields need `name`/`id` attributes (a minor a11y console warning).

## Next: Phase 3 — shaping + export

Per the plan:

1. **Via-point shaping** in `builder.js`: drag a leg to insert a shaping point
   into `route_legs.via_points`, re-route that leg only; draggable/deletable.
2. **`src/maps/export.ts`** — `buildKml` / `buildGpx` from structured rows,
   naming points via `formatRoleName` so files round-trip.
3. Make `/api/public/maps/:slug/kml` + `/gpx` **source-aware** (imported =
   stored original, native = generated) and flip the native `kmlUrl`/`gpxUrl`
   in `ride.json` from `null` to real URLs.

Then Phase 4 (unify viewer, import UI, retire Google + `GMAPS_KEY`), Phase 5
(multi-day + timeline slider).

## Near-term UX backlog (owner request, `changes-260724T0250Z.md`)

1. Drop the separate builder title heading — make **"Plan a ride" the
   placeholder** in the title field, clearing on input.
2. **Role picker is too many icons** — replace with a multi-select **dropdown**,
   each row an icon with its description beside it.
3. **Splash / login page**, and a **home page** listing the viewer's **last 10
   rides** and the **10 most popular public rides**. (Owner is working on a
   logo.)

## Environment / running

- Dev: Docker Desktop up → `docker compose up -d db` → `npm run dev` (port
  6686). Browse the **builder/native viewer at `http://localhost:6686`** (not
  `127.0.0.1` — Mapbox tiles 403 there). Imported-ride viewing (legacy Google)
  wants `127.0.0.1`.
- Mint a dev session cookie for API/browser testing:
  `npx tsx -e "import('./src/auth/session').then(async s=>{console.log(await s.createSession(1));process.exit(0)})"`
  then set `routeloop_session=<token>` (works from either dev host; the cookie is
  per-host, so set it on whichever origin you're testing).
- Dev DB right now: ride 1 = seeded `sample-route-one` (imported, public);
  ride 3 = `Test Loop` (native, unlisted). Re-running the seed wipes all and
  recreates only ride 1.
- Deps added this pivot: `@xmldom/xmldom`, `zod`.

## Deploy landmine

`maps` → `rides` rename: the NAS post-deploy `drizzle-kit push` is
non-interactive and can't resolve it. Before the first deploy of this branch,
`DROP TABLE IF EXISTS maps CASCADE;` on stage + prod DBs. Also wire `MAPBOX_TOKEN`
into the deploy env plumbing (mirror `GMAPS_KEY`). See STATUS.md → Known risks.
