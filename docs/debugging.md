# Debugging

Known failure modes, indexed by the symptom you will actually see. Add to this file whenever something costs you more than ten minutes.

## The map never draws, console says `RefererNotAllowedMapError`

The browser key's HTTP-referrer allow-list is wrong or was lost. It happened on 2026-07-30 after the Google Cloud project migration, hours after the allow-list had been recorded as verified.

The re-verify script is in [STATUS.md](STATUS.md#re-verifying-the-keys). Two traps in it:

- Building the `-H "Referer: …"` argument through a conditional variable expansion mangles the header, so every origin reports BLOCKED—which reads as "the restriction works" when nothing was sent. Pass the header literally.
- When every origin reports BLOCKED, **read the response body before believing it**. A grep for `suggestions` cannot tell "blocked" from "malformed request"; a body saying `API_KEY_HTTP_REFERRER_BLOCKED` means the restriction really was lost.

## Markers render nothing, no error

`GMAPS_MAP_ID` is unset or wrong. Advanced Markers need a vector Map ID and fail with a console warning and no visible marker, which reads as a data bug rather than a config one.

## Every leg fails as "no road route", Routes API returns HTTP 200 with an empty body

Something changed `travelMode` to `TWO_WHEELER`. It is served only in some South and Southeast Asian markets; in the United States it answers 200 with `{}`—no route, no error. `src/routes/routing.ts` uses `DRIVE` and says why in a comment so it does not get helpfully corrected.

## A scripted API call returns 403 and `{"error":"bad origin"}`

Every write carries `requireSameOrigin`. Send the header:

```bash
curl -b cookies.txt -H "Origin: http://127.0.0.1:6686" \
  -X POST http://127.0.0.1:6686/api/maps \
  -F "route=@ride.gpx" -F "title=Test" -F "visibility=private"
```

## `/dev/login` returns 404

It is not registered unless all four hold: `DEV_LOGIN_EMAIL` names an **existing** account (it will not create one), `DATABASE_URL` points at `127.0.0.1`, `localhost` or `host.docker.internal`, `APP_ORIGIN` is not HTTPS, and the request Host is `127.0.0.1` or `localhost`—not the LAN address. The server prints a warning at boot when it is on.

To mint a session with no browser at all:

```bash
npx tsx -e "import('./src/auth/session').then(async m => console.log(await m.createSession(1)))"
# send it as: Cookie: routeloop_session=<token>
```

## A 500 on sign-in saying `column users.<something> does not exist`

The database is behind `src/db/schema.ts`. Locally, `npm run dev` migrates first via `predev`; run `npm run db:migrate` directly if you are not starting the dev server. On a deployed environment this is either a failed `migrate` service or a stale volume adopted by a "fresh" deploy—see [deployment.md](deployment.md).

## `drizzle-kit migrate` fails on the first `CREATE TYPE` or `CREATE TABLE`

The database predates `drizzle/` and was built by `push`, so it already has everything the baseline migration wants to create. It needs a one-time baseline, and confirming the database actually matches `schema.ts` **before** baselining is the step not to skip. Full order in [database.md](database.md).

## The seed fails partway through

`src/db/seed.ts` reads `storage/1/1.kml` for its imported sample ride. Storage is gitignored, so on a machine without that file the seed dies at that line. `utils/seed-dev.sh --rides-only` skips it and seeds generated native rides only.

## A test compares a string to itself and passes

The pre-commit hook runs `utils/tighten-em-dashes.mjs` over staged `.md`, `.ts`, `.js` and `.mjs` files and rewrites spaced em dashes—including inside test fixtures. `test/em-dashes.test.ts` was once committed in exactly that state. Check what the hook re-staged before trusting a green run on a fixture full of dashes.

## A change under `utils/` typechecks clean and then fails at runtime

`utils/` is not in `tsconfig.json`'s `include`. Check it by hand:

```bash
npx tsc --noEmit --strict --target ES2022 --module ESNext --moduleResolution Bundler \
  --types node --esModuleInterop --skipLibCheck utils/seed-demo-rides.ts
```

## The page does not live-reload

`npm run dev` starts `sass --watch` alongside the server and serves an SSE endpoint at `/__dev/reload` plus an inline snippet in `page()`, both gated on `IS_DEV` (`APP_ORIGIN` not being HTTPS). A stylesheet change swaps the `<link>` in place rather than reloading, so map state survives; a `public/js/` change or a server restart reloads the page. `npm run dev:server` starts the server without the watcher, so SCSS changes will not appear at all.

## The port is already bound

Port 6686 belongs to this project. Kill whatever holds it and restart on the same port—two instances on two ports is how you end up debugging the one you are not looking at.

## The dashboard's quota total disagrees with itself

`users.used_bytes` is a denormalized cache incremented on import and decremented on delete, with no reconciler, so it drifts and has. The dashboard computes the authoritative sum alongside it and reports the disagreement rather than trusting the cache. If the drift is new, check that every byte column is still named in the `rides.size_bytes` generated expression.
