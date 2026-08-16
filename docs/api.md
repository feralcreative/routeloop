# Endpoints

Every route, its gate, and the shape it speaks. Handlers live in `src/routes/*` and `src/index.tsx`; the gates are in `src/auth/middleware.ts`.

A host middleware runs ahead of everything: requests for `tankbag.app`, `www.tankbag.app`, `stage.tankbag.app` and `www.routeloop.app` get a 301 to the same path and query on the canonical host. A request on a non-canonical hostname is redirected before any auth handler sees it.

## Gates

| Gate                                 | Effect                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `withSession`                        | Resolves the session once per request; runs for everything after the static assets |
| `requireAuth` / `requireAuthApi`     | Signed in. The `Api` variant answers JSON instead of redirecting                   |
| `requireActive` / `requireActiveApi` | `users.status = 'active'`. Pending riders land on `/welcome`                       |
| `requireManageRiders`                | Admin surfaces                                                                     |
| `requireSurvey`                      | The rider survey                                                                   |
| `requireSameOrigin`                  | CSRF. Checks `Origin` via `isAllowedOrigin` in `src/config.ts`—every write has it  |

Public ride reads are gated by `getViewable(slug, viewer)` in `src/index.tsx`: public and unlisted for anyone, private for the owner only, otherwise 404. Unknown and forbidden slugs are indistinguishable on purpose.

## Public

| Route                                                            | Notes                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                                                          | Public ride listing (`routes/home.tsx`)                                                                                                                                                     |
| `GET /m/:slug`                                                   | Viewer page—one shell for both sources                                                                                                                                                      |
| `GET /m/:slug/navigate`                                          | The Google Maps hand-off: each day as ordered `/maps/dir/?api=1` links carrying 9 waypoints plus two ends, with an Expand density control (off / light / tight). `routes/handoff.tsx`       |
| `GET /m/:slug/roadbook`                                          | Printable stop-by-stop sheet, server-rendered, no JavaScript. `routes/roadbook.tsx`                                                                                                         |
| `GET /api/public/rides/:slug/ride.json`                          | The normalized viewer contract for both sources: ride meta plus `days[]`, each with `track`, `stops[]`, `pois[]` and `legs[]` carrying `startIndex`/`endIndex` spans into that same `track` |
| `GET /api/public/maps/:slug/:format{kml\|gpx\|geojson\|csv}`     | Gated download. **Source-aware:** an imported ride streams its stored original byte-for-byte for the format it arrived in; every other format is generated from the rows                    |
| `GET /api/public/maps/:slug/routeloop.json`                      | Lossless native export                                                                                                                                                                      |
| `GET /api/public/maps/:slug/zip/:format{kml\|gpx\|geojson\|csv}` | One conforming file per day. **Registered ahead of the generic `:format` route on purpose**—after it, the generic route swallows `/zip/gpx` and answers with a plain GPX                    |
| `GET /explore`, `/faq`, `/privacy`, `/terms`                     | `routes/pages.tsx`                                                                                                                                                                          |
| `GET /@username`                                                 | Public profile (`/:handle{@…}` in `routes/pages.tsx`)                                                                                                                                       |
| `GET /riders`                                                    | Signed-in only—an anonymous list of every account is a scraping target with no upside                                                                                                       |

## Auth (`routes/auth.tsx`)

`GET /login`, `GET /auth/google`, `GET /auth/google/callback`, `POST /auth/magic`, `GET /auth/magic/:token`, `GET`/`POST /choose-name`, `GET /welcome`, `POST /logout`.

`GET /dev/login` registers **only** when `DEV_LOGIN_EMAIL` names an existing account, `DATABASE_URL` is local, `APP_ORIGIN` is not HTTPS, and the request Host is `127.0.0.1` or `localhost`. When off it is a plain 404, not a refusal. It is not on the deploy's env allow-list, so it cannot reach a server.

## Owner API

All of these carry `requireAuthApi` (or `requireActiveApi`) plus `requireSameOrigin`.

| Route                                                         | Notes                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/maps`                                              | Import: KML, KMZ, GPX, GeoJSON, CSV, a `.zip` of any of those, or native Routeloop JSON → structured rows. Full XXE-safe pipeline plus transactional quota. `routes/maps.ts`                                                                                                          |
| `PATCH /api/maps/:id`, `DELETE /api/maps/:id`                 | Edit and delete, owner-scoped, both sources                                                                                                                                                                                                                                           |
| `POST /api/rides`, `PUT /api/rides/:id`, `GET /api/rides/:id` | Builder create, full-replace save, owner load. `routes/builder.ts`—renamed from `rides.ts` in [#104](https://github.com/feralcreative/routeloop/pull/104); `routes/rides.tsx` is the ride-list page and a different file                                                              |
| `POST /api/rides/:id/clone`                                   | Rebuilds a public native ride through the same `insertRideGraph`. **Drops** descriptions (stop notes are where "gate code 4417" lives), times and via points, and lands private. Private and imported rides 404 rather than 403, so the endpoint confirms nothing                     |
| `POST /api/route`                                             | `{origin, destination, vias?}` as `[lng,lat]` in, `{geometry, distanceM, durationS}` out. Proxies Google Routes because the server key is IP-restricted; caches computed legs because editing re-requests the same pair constantly. `routes/routing.ts`                               |
| `POST /api/geocode`                                           | Beside it, for the same reason. **A miss is cached as well as a hit**—a half-typed address is resubmitted constantly and a failed lookup bills the same. Geocoding reports "found nothing" as HTTP 200 with `ZERO_RESULTS`, handled explicitly rather than falling through as success |

Import specifics: several files posted at once become the days of one ride, and all are validated before any is parsed so a bad tenth file names itself rather than leaving nine days half-imported. A zip is expanded before anything asks what format a file is, so nothing downstream ever sees one. Day order comes from the `dNN` filename field when every file carries one, and from upload order otherwise—partial sets keep upload order, because interleaving numbered and unnumbered files needs a rule nobody asked for. The form is `routes/import.tsx`, enhanced by `public/js/import.js` into a drop box that fills it from the filenames.

## Pages

| Route                              | Gate                                                               |
| ---------------------------------- | ------------------------------------------------------------------ |
| `GET /builder`, `GET /builder/:id` | `requireAuth`, owner-checked, native rides only. `routes/builder.ts` |
| `GET /`                            | The dashboard—hero miles, tiles, storage meter, twelve-month chart, from `src/stats/`. `routes/home.tsx` |
| `GET /rides`                       | Owner ride list. `routes/rides.tsx`                                |
| `GET /dashboard`                   | **301 to `/rides`** since 2026-08-15. The name described the page as a dashboard when the dashboard is `/` |
| `GET`/`POST /profile`              | Profile form and username reservations                             |
| `GET /import`                      | Import **and** export, one page under one `<h1>`: the multi-file upload form, and a per-format download row per owned ride |
| `GET /settings`                    | The rider's preferences. Currently one setting, the stop-duration format, shipped 2026-08-15; **planned to move to `/prefs`**, see `docs/main-menu.md` |
| `GET /brand`                       | Signed-in palette audit read live from the SCSS                    |

## Invites and survey

| Route                                                                                                               | Gate                                                                                   |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /i/:token`, `POST /i/accept`                                                                                   | `requireAuth`, **not** `requireActive`—a pending rider is exactly who an invite is for |
| `GET /admin/invites`, `POST /admin/invites`, `POST /admin/invites/:id/revoke`, `POST /admin/invites/:id/regenerate` | `requireManageRiders`                                                                  |
| `GET`/`POST /survey`, `GET /survey/thanks`                                                                          | `requireSurvey`                                                                        |
| `GET /admin/survey`, `GET /admin/survey.csv`                                                                        | `requireManageRiders`                                                                  |
| `GET /admin`, `GET /admin/approvals`, `POST /admin/riders/:id`                                                      | `requireManageRiders`—the reader of `users.status`                                     |

The rule and the claim are deliberately separate: `src/invites/policy.ts` holds what an invite may do as pure functions, and the conditional `UPDATE … RETURNING` in `service.ts` is the race guard, so two riders taking the last seat cannot both win.

## The ride payload (save = load shape)

Defined in `src/maps/ride-graph.ts`, not in `routes/builder.ts`, so the native JSON import validates and inserts through exactly the code the builder's save does. A second path that agreed with it today would drift tomorrow.

```json
{
  "title": "...",
  "description": "",
  "visibility": "private",
  "external_url": "",
  "days": [
    {
      "title": "",
      "color": "#0066cc",
      "startAt": null,
      "endAt": null,
      "stops": [
        {
          "lat": 0,
          "lng": 0,
          "name": "",
          "description": "",
          "roles": ["gas"],
          "durationMin": null
        }
      ],
      "pois": [
        { "lat": 0, "lng": 0, "name": "", "description": "", "roles": [] }
      ],
      "legs": [
        {
          "geometry": [[0, 0]],
          "distanceM": 0,
          "durationS": 0,
          "viaPoints": []
        }
      ]
    }
  ]
}
```

Geometry pairs are `[lng, lat]`.

Server-side integrity on save: all text is sanitized, coordinates are rounded to 6 decimals, and each leg's claimed `distanceM` is clamped to the haversine length of its geometry if it deviates by more than 15 %—Directions stays authoritative in the honest case, and spoofing is bounded.

Caps, exported from `ride-graph.ts` rather than repeated in callers: `MAX_DAYS` 31, `MAX_STOPS` 200 and `MAX_POIS` 200 per day, `MAX_VIAS_PER_LEG` 20, `MAX_PTS_PER_LEG` 25,000, `MAX_PTS_PER_RIDE` 200,000, and at most 4 roles per point (also checked by the database).

**One rendering path, and now one shape.** Every ride—imported or native—stores one leg per pair of consecutive stops. An import used to be the exception, holding its whole track in a single leg at position 0, which is what made it impossible to open in the builder; the import splits the track at its stops now (`src/maps/track-split.ts`). Viewers still render `concat(legs)` per day and cannot tell the two apart, which is what made the change invisible to every reader.
