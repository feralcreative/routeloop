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
| `GET /api/public/rides/:slug/ride.json`                          | The normalized viewer contract for both sources: ride meta plus `days[]`, each with `track`, one ordered `points[]` and `legs[]` carrying `startIndex`/`endIndex` spans into that same `track` |
| `GET /api/public/maps/:slug/:format{kml\|gpx\|geojson\|csv}`     | Gated download. **Source-aware:** an imported ride streams its stored original byte-for-byte for the format it arrived in; every other format is generated from the rows                    |
| `GET /api/public/maps/:slug/routeloop.json`                      | Lossless native export                                                                                                                                                                      |
| `GET /api/public/maps/:slug/zip/:format{kml\|gpx\|geojson\|csv}` | One conforming file per day. **Registered ahead of the generic `:format` route on purpose**—after it, the generic route swallows `/zip/gpx` and answers with a plain GPX                    |
| `GET /explore`, `/faq`, `/privacy`, `/terms`                     | `routes/pages.tsx`                                                                                                                                                                          |
| `GET /@username`                                                 | Public profile (`/:handle{@…}` in `routes/pages.tsx`)                                                                                                                                       |
| `GET /riders`                                                    | Signed-in only—an anonymous list of every account is a scraping target with no upside. Both halves of every blocked pair drop out of it, symmetrically                                     |

## Auth (`routes/auth.tsx`)

`GET /login`, `GET /auth/google`, `GET /auth/google/callback`, `POST /auth/magic`, `GET /auth/magic/:token`, `GET`/`POST /choose-name`, `GET /welcome`, `POST /logout`.

`GET /dev/login` registers **only** when `DEV_LOGIN_EMAIL` names an existing account, `DATABASE_URL` is local, `APP_ORIGIN` is not HTTPS, and the request Host is `127.0.0.1` or `localhost`. When off it is a plain 404, not a refusal. It is not on the deploy's env allow-list, so it cannot reach a server.

## Friendships (`routes/friends.tsx`)

`GET /friends` is the page. The five verbs are one route, `POST /friends/:verb{request|accept|remove|block|unblock}`, behind `requireActive` and `requireSameOrigin`, taking a `handle` and a `back` path as a form post and answering 303 to `back` in every case.

**Every answer is identical whether it worked or not.** No verb reports which refusal it hit, and an unknown handle is indistinguishable from one that has blocked you. That is what makes a block work: a distinguishable refusal is a notification. `back` is validated as an allow-shape (one leading slash, no second one, no backslash) rather than sanitized, and anything failing it lands on `/friends`.

The rules are `src/friends/policy.ts` and the queries `service.ts`. One row per pair under a canonical ordering—`rider_a < rider_b`, enforced by `ck_friendship_order`—so `requested_by` and `blocked_by` carry the direction the columns cannot.

## The roster (`routes/roster.tsx`)

`GET /m/:slug/riders` is the page—who is on a ride, what they said, and the ballot for its alternates. Its verbs are `POST /m/:slug/riders/{invite,remove,rsvp,perm,vote,resolve,deadline}`, all behind `requireActive` and `requireSameOrigin`, all form posts answering 303 back to the page with any refusal in `?error=`.

**Gated on MEMBERSHIP, not visibility.** A public ride is readable by anyone and its roster is not: who is coming on a ride is a fact about people, and a share link is permission to see a route. Not-found rather than forbidden, the same as every other refusal that touches a slug.

**You can only add a friend.** `invite` takes a handle and refuses anything that is not an accepted friendship—there is no token path, no email path and no account creation. See `docs/decisions.md` for why that replaced ride invites rather than deferring them.

`bike` is yours only and owner-scoped over the bikes as well as the membership, so a forged id cannot pull somebody else's machine into the group's range calculation. `group`—which approach a rider is on—is OWNER-only, and that is the difference from the RSVP beside it: being on the Oakland run is a fact about the plan rather than a statement by the rider. It is scoped to this ride's own subgroups, because the foreign key alone would accept an id from somebody else's.

### The builder's Riders tab, over JSON

`GET /api/rides/:id/comments` reads a ride's comments—both anchors in one list, point-level by uid and ride-level when the uid is null. Its verbs are `POST /api/rides/:id/comments` and `POST /api/rides/:id/comments/:cid/{resolve,delete}`. Reading needs `view` on the roster, posting needs `comment`, and deleting or closing is the author or an owner. **Roster-gated and never visibility-gated**: a share link is permission to see a route, not to write on it.

`GET /api/rides/:id/suggestions` reads every suggestion on a ride with its state derived against what the ride says right now—`pending`, `stale`, or the outcome. `POST /api/rides/:id/suggestions` proposes one day; `POST /api/rides/:id/suggestions/:sid/{accept,discard,withdraw}` decides it. Accept is owner-only and answers **409** when the target day has changed since the proposal was made. Every rider on the roster sees every pending suggestion, deliberately—two riders proposing the same reroute and neither knowing is the failure that avoids.

`GET /api/rides/:id/riders` reads the roster for the builder's Riders tab: every rider with their role, RSVP, bike label and `subgroup_id`, plus the ride's subgroups by **both id and uid**, the group's binding fuel range, and how many are coming. Its two verbs are `POST /api/rides/:id/riders/{group,remove}`, behind `requireActiveApi` and `requireSameOrigin`.

**Owner-gated and keyed by ride id**, not membership and not by slug—the same gate and the same key as `/api/rides/:id/rendezvous`, because only an owner reaches the builder. A rider who is on a ride but does not own it has the page.

**Three verbs, not a second roster.** RSVP, bike, invite, the vote and its deadline stay on the page: those are statements by a rider rather than decisions by the planner. What is here is the read plus the two that are about the plan. Both call the same service functions the form handlers do—`assignRider` behind the same ride-scoping check, `removeMember` behind `canRemove`—so no gate is decided twice.

**The subgroups come back by uid as well as by id** because that is the one place the two identifier spaces meet: the builder mints uids client-side and `reconcileSubgroups` matches on them, while `ride_members.subgroup_id` is a numeric id that does not exist until the ride has been saved. A group added since the last save is in neither list, and the tab says so rather than leaving it silently unpickable.

`POST /api/rides/:id/rendezvous` proposes meeting points for one subgroup, owner-only. The whole computation is pure geometry and calls no router—ranking candidates through the Routes API would be a Routes bill per keystroke, and the proposal is a suggestion the planner accepts, at which point the ordinary routing path draws the real road. An empty `candidates` with a `reason` is a real answer: `no-trunk`, `no-days`, or `none-viable`.

**Every per-rider surface takes `?group`.** The roadbook, the hand-off page, all four file formats and the per-day zip narrow to one subgroup's strand—their own approach plus every shared day. Derived from membership when not given, `?group=all` for the whole ride. `ride.json` deliberately does the OPPOSITE and tags every day rather than filtering, because the viewer draws the whole converge-and-split shape and dims what the reader is not on.

`rsvp` is yours only, the owner's included. `remove` is both "remove somebody" and "leave", which are the same row going away; the owner cannot remove themselves, because a ride with no owner has nobody who can invite, resolve or delete it. `vote` is one pick per member per alternate group and pressing your own pick again withdraws it. `resolve` and `deadline` are owner-only.

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
| `POST /api/places/search`                                     | `{query, near?, radiusM?}` in, `{places: [{name, address, lngLat, type}]}` out. Places **Text Search**, which is what answers "a gas station in Oakdale"—Autocomplete matches names and addresses, so asked for a category it returns only businesses literally called that. Cached, because Text Search bills per call and costs more than the Autocomplete session beside it. **The place in the query is not geocoded separately**: Text Search reads "X in Y" itself, so `near` is only for a category chip, which has no place in its text |

**`/api/places/search` needs Places API (New) on `GMAPS_SERVER_KEY`.** A key restricted to Routes and Geocoding answers every Text Search with `403 API_KEY_SERVICE_BLOCKED`, so the route detects exactly that and returns a 503 naming the fix rather than a generic outage. The browser key already has Places—that is what the Autocomplete uses—so the two keys need different API lists.

Import specifics: several files posted at once become the days of one ride, and all are validated before any is parsed so a bad tenth file names itself rather than leaving nine days half-imported. A zip is expanded before anything asks what format a file is, so nothing downstream ever sees one. Day order comes from the `dNN` filename field when every file carries one, and from upload order otherwise—partial sets keep upload order, because interleaving numbered and unnumbered files needs a rule nobody asked for. The form is `routes/import.tsx`, enhanced by `public/js/import.js` into a drop box that fills it from the filenames.

### The import review manifest

`POST /api/maps` takes one optional extra field, `manifest`: a JSON array of `{fileName, title, startAt}`, one entry per posted file, **in the same order and with names that match**. It is what the review table (#129) posts when a rider corrects the guess, and `src/maps/manifest.ts` is the whole rule.

- **No manifest means what it always meant.** Absent, empty, or posted by an API client: the server derives day order, dates and names from the filenames exactly as before. That is what keeps the form working with JavaScript off.
- **A manifest suppresses the day-number sort.** The posted order IS the reviewed order, because the page rebuilds its own file input to match what the rider dragged. The name-and-position check is what proves the two agree; a mismatch is a 400 rather than a ride whose second day carries the third day's date.
- **`startAt` is a wall clock**, `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, parsed as UTC like every other day clock in this app. An unparseable one names itself in the error.
- **A zip gets an entry that carries nothing.** Nothing unzips in the browser, so an archive's days are still read on the way in; its row exists to keep the positions lining up.
- **A typed name outranks the file's own.** Precedence is typed → the file's internal name (`<trk><name>`) → the filename's title field → the mangled filename. An empty box is "I did not answer" rather than "no name", because the table only ever shows what the FILENAME said—and so is an **untouched** box: the review pre-fills it from the filename, so `import.js` sends a title only where the rider actually edited one. Without that, importing a file with JavaScript on and off gives its day two different names.

### Export search and the cart

| Route | Notes |
| --- | --- |
| `GET /api/export/search?q=` | Owner-scoped ride search for the export cart, capped at 12. Name **and the days' dates**—never `rides.created_at`, because a rider searching "August" means when they rode. `src/maps/ride-search.ts` reads the box; a bare month name ORs against the title so "August Loop" is still findable |
| `POST /export/zip` | One zip of the cart: `cart` is a JSON array of `{slug, format}`, at most 20. A plain form post rather than fetch, so the browser handles the attachment. Ownership is re-checked per slug and a slug that is not the rider's own is skipped rather than refused, so a stale cart still exports the rest |

**`/api/export/search` and not `/api/rides/search`**: `GET /api/rides/:id` is registered ahead of it and matches that path with `id = "search"`, so the endpoint answered `{"error":"not found"}` with nothing to say why. Ordering the mounts around it would work and would break again the next time somebody moved a line in `index.tsx`.

## Pages

| Route                              | Gate                                                               |
| ---------------------------------- | ------------------------------------------------------------------ |
| `GET /builder`, `GET /builder/:id` | `requireAuth`, owner-checked, native rides only. `routes/builder.ts` |
| `GET /`                            | The dashboard **and** the owner's ride list—hero miles, tiles, storage meter, twelve-month chart from `src/stats/`, then every ride they own. `routes/home.tsx`. The list is capped; `?rides=all` lifts it to a higher ceiling rather than removing it |
| `GET /rides`                       | **302 to `/`** since 2026-08-24, when the list folded into the dashboard. A 302 rather than a 301 because this is a layout decision that has been revisited once already. `routes/rides.tsx` is now nothing but this redirect |
| `GET /dashboard`                   | **301 to `/`**—301 to `/rides` from 2026-08-15, repointed at the destination on 2026-08-24 so it does not chain through a second redirect |
| `GET`/`POST /profile`              | Profile form and username reservations                             |
| `GET /import`                      | Import **and** export, one page under one `<h1>`: the multi-file upload form with its editable review table, and the export search box and cart. Asks the database one question about the rider's rides—"do you have any"—since the rides themselves arrive through `/api/export/search` |
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

## Rider feedback (`routes/feedback.tsx`)

| Route                                     | Gate                                     | Notes                                                                                                                                                                              |
| ----------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /feedback`                           | `requireActive`                          | The intake. Accepts `?kind=` and `?area=` so an entry point can pre-fill both                                                                                                      |
| `POST /feedback`                          | `requireActive` + `requireSameOrigin`    | Multipart. `action=next` advances a screen and writes nothing; `action=send` creates the report, its diagnostics row and any attachments in one transaction                        |
| `GET /feedback/mine`                      | `requireActive`                          | The rider's own reports, every state—the one surface where they see their own declined and duplicate rows                                                                          |
| `GET /feedback/thanks`                    | `requireActive`                          | Full-screen confirmation. A toast that has already faded is indistinguishable from a form that silently failed                                                                     |
| `GET /feedback/:publicId`                 | `requireActive`                          | One report. `visibleTo` decides, and a report the viewer may not see is a **404, not a 403**—matching the ride-slug precedent, because a 403 confirms someone reported something   |
| `GET /feedback/:publicId/photo/:n`        | `requireActive`                          | One attachment, gated by the same `visibleTo` as the report. A storage key is a path, not a capability                                                                             |
| `GET /board`                              | `requireActive`                          | Published **ideas** only. Signed-in only, the same reasoning as `/riders`                                                                                                          |
| `POST /board/:publicId/want`              | `requireActiveApi` + `requireSameOrigin` | Idempotent toggle. Answers JSON when `Accept` asks for it and redirects to `/board` otherwise, so the button works with no JavaScript                                              |
| `GET /admin/feedback`                     | `requireManageRiders`                    | The queue. Pending first, then newest; filterable by state and kind                                                                                                                |
| `GET /admin/feedback/:id/diagnostics`     | `requireManageRiders`                    | The stored blob for one report, read through `parseDiagnostics`. Its own page because it is 5–50 KB and forty of them inline would make the worklist unusable                       |
| `POST /admin/feedback/:id`                | `requireManageRiders` + `requireSameOrigin` | Moderation. Fields are optional and only what is present is written                                                                                                             |

`/feedback/mine` and `/feedback/thanks` are registered **before** `/feedback/:publicId`, or the parameterized route swallows them—the same class of bug as the zip route ordering above.

**Two columns, not one.** `state` is the owner's gate (`pending`, `published`, `declined`, `duplicate`, `spam`) and controls visibility; `status` is the rider-facing lifecycle. They are orthogonal on purpose: a bug is routinely `fixed` while still `pending`, and collapsing them into one enum is the mistake the pair exists to prevent. **This is also what makes a bug private without a private-bug feature**—nothing is visible to anyone but its author and the owner until it is `published`, and nothing publishes a bug by default.

`POST /admin/feedback/:id` only writes the fields it is given, so the queue's several small forms cannot blank each other's values. Two behaviors worth knowing: `not_doing` is refused without a `publicResponse`, because that status's whole content is the explanation; and `mergeInto` is a separate operation from the `duplicateOf` field, because merging *moves vote rows onto another report* and setting the field only records the relationship.

Wants are deduplicated by Postgres rather than by application code. The composite primary key on `feedback_votes` is the one-per-rider guarantee, the toggle reads what it actually wrote instead of asking first, and `mergeDuplicate` transfers votes with `INSERT … SELECT … ON CONFLICT DO NOTHING`—so a rider who wanted both the original and the duplicate is counted once.

Diagnostics are collected client-side, redacted server-side by `src/feedback/diagnostics.ts`, and **never stored unredacted**: query strings and fragments are stripped from every URL, coordinate pairs are dropped wherever they appear, and geolocation is recorded as a permission state and never a position.

## Release notes

| Route | Gate | Returns |
| --- | --- | --- |
| `GET /release-notes` | public | The full page, chrome and all—the no-JavaScript path and the linkable URL |
| `GET /api/release-notes` | public | The same copy as a bare HTML fragment, fetched by the modal on first open |

One source, `src/content/release-notes.html`. The fragment exists so the notes—which only get longer—are not on every HTML response for a dialog most riders never open. The modal hides the fragment's `<h1>` and lede in CSS rather than the server stripping them, because the standalone page wants both.

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
      "altGroup": null,
      "altActive": true,
      "points": [
        {
          "kind": "stop",
          "lat": 0,
          "lng": 0,
          "name": "",
          "description": "",
          "roles": ["gas"],
          "durationMin": null
        },
        { "kind": "poi", "lat": 0, "lng": 0, "name": "", "description": "", "roles": [] }
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

`points` is **one ordered list and the array order is the rider's order**, for both kinds. It replaced the `stops` and `pois` arrays on 2026-08-23, when a point became something created as a POI and promoted later—two arrays cannot express one order without a redundant position field on each. `kind` defaults to `"poi"`, which is the baseline type.

**Legs connect consecutive POINTS, both kinds**, so `legs.length === max(0, points.length - 1)`. Ziad's call, 2026-08-24: a POI is something the rider will at least ride BY, so it is always part of the route and only `kind` says whether they mean to stop there. `kind` therefore touches nothing about routing—promoting a point is a flag flip that changes the row's number and the marker's size and leaves the road identical. At least one stop per day is still the rule, and the builder upholds it by promoting the first point of every day, but the reason is no longer routing: a day of nothing but POIs draws a complete road, and what it lacks is the numbered roadbook rows, the Maps hand-off, and somewhere for `start`/`finish` to live.

The cost worth knowing: **adding a POI is a Routes request now**, where it used to be free, because it splits the leg it lands in.

**`ride.json` sends the same one ordered `points` array** as of 2026-08-24, with `kind` on each element. It used to send `stops` and `pois` as two arrays, deliberately: the viewer draws markers and a timeline and never rendered points as a sequence, so it gained nothing from the interleaving. That stopped being true the moment a POI joined the route—`ride-time.js` walks the points and the legs together to build a day's schedule, and two arrays cannot tell it the order.

`altGroup` and `altActive` mark alternate days—two or more candidates for the same stretch, of which exactly one counts. Both default, so a file written before they existed still validates and `NATIVE_FORMAT_VERSION` did not move. The server re-resolves them on every write: a group of one is dissolved, exactly one member is elected active, and group ids are renumbered densely from 0—so what comes back is not always what was sent, and that is the contract rather than a bug. `ride.json` sends every day including the losing alternates, because the viewer has to receive one in order to ghost it; the four lossy export formats send only the active days, because none of them can express "this is an option" and a re-import would silently promote every loser to a real day.

Server-side integrity on save: all text is sanitized, coordinates are rounded to 6 decimals, and each leg's claimed `distanceM` is clamped to the haversine length of its geometry if it deviates by more than 15 %—Directions stays authoritative in the honest case, and spoofing is bounded.

Caps, exported from `ride-graph.ts` rather than repeated in callers: `MAX_DAYS` 31, `MAX_STOPS` 200 and `MAX_POIS` 200 per day, `MAX_VIAS_PER_LEG` 20, `MAX_PTS_PER_LEG` 25,000, `MAX_PTS_PER_RIDE` 200,000, and at most 4 roles per point (also checked by the database).

**One rendering path, and now one shape.** Every ride—imported or native—stores one leg per pair of consecutive points, both kinds. An import used to be the exception, holding its whole track in a single leg at position 0, which is what made it impossible to open in the builder; the import projects every point onto the track and slices at each one now (`src/maps/track-split.ts`). Viewers still render `concat(legs)` per day and cannot tell the two apart, which is what made the change invisible to every reader.
