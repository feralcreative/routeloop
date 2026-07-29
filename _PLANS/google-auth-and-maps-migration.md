# Google auth and Google Maps migration

## Context

Two pivots on `refactor/google-maps-and-auth`, decided from the cost and terms analysis in [docs/decisions-auth-and-search.md](docs/decisions-auth-and-search.md).

**Auth.** Cloudflare Access is billed per seat — $7/user/month for every user past 50 — so it cannot survive opening signups. Replace it with Google OAuth plus a magic link, both owned by the app. `users.status` stays as the capacity gate, which is what lets the audience stay small on a NAS while the door is technically open.

**Maps.** Place search on Mapbox Geocoding is not good enough for finding businesses. Google's terms forbid Places content on a non-Google map, so this is necessarily a whole-engine switch: rendering, search and routing together.

### Decisions taken

| Question | Decision |
| --- | --- |
| Auth providers | Google OAuth **and** a hand-rolled magic link, built together |
| Magic-link sending | Google SMTP, on a credential separate from the OAuth client |
| Places UI | `PlaceAutocompleteElement`, the prebuilt web component |
| Routing calls | Server proxy — you are creating the IP-restricted key |
| Imported-ride viewer | Unify onto the new engine and delete `main.js` |

### Three findings that make this smaller than it looks

**`map-common.js` is a real abstraction, not a wrapper.** Of its 13 exported functions only six touch `mapboxgl` — `initMap`, `fitTo`, the four route-layer functions and `attachPopup`. The other seven (`markerElement`, `popupHtml`, `stopMileages`, `iconSvg`, `esc`, `hydratePopupIcons`, `initPanelToggle`) are pure DOM and arithmetic and port **unchanged**.

**The stylesheet is already Google-shaped.** There is not one `mapboxgl-*` selector in `style/`. `_map.scss` still carries `.gm-ui-hover-effect` and the `.waypoint-tooltip` block, both written for the legacy Google viewer. The CSS gets simpler, not harder.

**No stored data changes.** Routes API accepts `polylineEncoding: GEO_JSON_LINESTRING` and returns a GeoJSON LineString, so `route_legs.geometry` keeps its `[lng,lat][]` shape. No migration, no backfill, and existing rides render on the new engine untouched.

There is also a working reference implementation in the repo: [public/js/main.js](public/js/main.js) is 1,135 lines of `google.maps` doing markers, polylines, arrows, InfoWindow tooltips and mileage. Read it before writing the new engine — much of this is an un-port rather than a port.

<!--| PAGE-BREAK -->

## Phase 0 — validate the premise first

Half a day, thrown away afterwards. The entire maps migration rests on "Google's search is better", which is currently an assumption.

Build a standalone scratch page — a Google map, a `PlaceAutocompleteElement`, nothing else — and search the things that disappointed you on Mapbox. Do not wire it into the app; a Google search box over a Mapbox map is the exact ToS violation being avoided, and it will not be shippable.

If Google is not clearly better on your real queries, stop and reconsider. The rest of this plan is days of work premised on that answer.

## Phase 1 — shared prep

**Extract the origin helpers.** `APP_ORIGIN` and `isAllowedOrigin` currently live in [src/auth/access.ts](src/auth/access.ts), which is about to be deleted, and are imported by `middleware.ts` and `routes/auth.ts`. Move both to `src/config.ts` first, as their own commit. Everything else in `access.ts` then becomes deletable without touching the CSRF gate.

**Config.** `GMAPS_KEY` (browser) and `GMAPS_SERVER_KEY` are already wired end to end. Add `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAPS_MAP_ID`, and the SMTP values. `MAPBOX_TOKEN` and `MAPBOX_GL_VERSION` stay until Phase 4.

## Phase 2 — auth

`npm i arctic nodemailer`. Arctic was uninstalled when Access landed; it is coming back for the same reason it was there before.

### Schema

```ts
providerEnum  += 'email'          // magic link is an identity like any other

login_tokens
  id          varchar(64) PK      // sha256 of the emailed token, never the token
  email       varchar(255) notNull
  expiresAt   timestamp notNull   // 15 minutes
  consumedAt  timestamp           // single use
  createdAt   timestamp notNull
  index (email, createdAt)        // rate limiting reads this
```

Reuse [generateSessionToken and hashToken](src/auth/session.ts#L28) verbatim — the magic-link token wants exactly the same properties as a session token, and storing only the hash means a leaked table yields nothing usable.

### Files

- **`src/auth/google.ts`** — Arctic Google client. Authorization URL with state and PKCE, callback exchange, userinfo fetch. State and code verifier go in short-lived httpOnly cookies following the [setSessionCookie pattern](src/auth/session.ts#L89), including its `SECURE_COOKIES` derivation.
- **`src/auth/magic.ts`** — issue, send, redeem. Redemption sets `consumedAt` **inside the same transaction** that creates the session, or a forwarded email is a replayable credential.
- **`src/auth/mailer.ts`** — nodemailer over Google SMTP.
- **`src/auth/identity.ts`** — generalize `resolveAccessUser` into `resolveUser({provider, providerUserId, email, displayName})`. Keep its existing behavior exactly: link to a verified-email user where one exists, create as `pending` otherwise, `OWNER_EMAIL` as `active`, and never demote an existing account on re-login.
- **`src/routes/auth.ts`** — rewrite. `GET /auth/google`, `GET /auth/google/callback`, `POST /auth/magic`, `GET /auth/magic/:token`. `/welcome` and `/logout` stay as they are, minus the Cloudflare logout branch.
- **Delete `src/auth/access.ts`.**

### The hazard

`accessEmail()` trusts an inbound `Cf-Access-Authenticated-User-Email` header. That is safe only while Access sits in front and strips it. **The header trust and the Access application must go in the same change** — leave the code in place after the policy is removed and anyone who can reach the origin mints a session for any address by setting a header. The `DEV_AUTH_EMAIL` fallback goes with it.

### Magic-link specifics

- Rate limit per email **and** per IP. Without it the endpoint sends attacker- chosen mail to arbitrary inboxes on your domain's reputation.
- Identical response whether or not the address has an account. Only the mail differs.
- Gmail SMTP caps around 2,000 recipients/day on Workspace, 500 on a consumer account. Fine for an alpha, and a wall later — worth a log line when a send fails so it is visible rather than mysterious.

<!--| PAGE-BREAK -->

## Phase 3 — the map engine

### Loading

Replace `MAPBOX_CSS_LINK` in [src/views/layout.ts](src/views/layout.ts) — Google needs no stylesheet — and load via the inline bootstrap so libraries come in on demand:

```js
google.maps.importLibrary("maps")     // Map
google.maps.importLibrary("marker")   // AdvancedMarkerElement
google.maps.importLibrary("places")   // PlaceAutocompleteElement
google.maps.importLibrary("geometry") // spherical.computeDistanceBetween
```

`geometry` can replace the hand-rolled haversine in [builder.js](public/js/builder.js#L59) and the clamp check in [rides.ts](src/routes/rides.ts), but that is optional cleanup, not required.

### `map-common.js` — rewrite six functions, keep seven

| Function | Mapbox | Google |
| --- | --- | --- |
| `initMap` | `new mapboxgl.Map` | `new google.maps.Map`, needs `mapId` |
| `fitTo` | `LngLatBounds` | `LatLngBounds` + `fitBounds` |
| `addRouteLayers` | GeoJSON source + line layer + canvas arrow image | one `Polyline` with `icons: [{icon: FORWARD_CLOSED_ARROW, repeat: '120px'}]` |
| `removeRouteLayers` | remove layers + source | `polyline.setMap(null)` |
| `updateRouteTrack` | `source.setData` | `polyline.setPath` |
| `setRouteVisible` / `setRouteDim` | layout/paint properties | `setVisible` / `strokeOpacity` |
| `attachPopup` | `mapboxgl.Popup` | `InfoWindow`, as `main.js` already does |

The arrow work gets deleted outright: `ensureArrowImage` draws a triangle to a canvas and registers it as a map image purely because Mapbox has no built-in line symbol. Google's `Polyline.icons` does it natively.

Markers become `AdvancedMarkerElement` with `content` set to the element `markerElement()` already returns — which is why that function needs no changes. **Advanced Markers require a Map ID**, a console action; see below.

### Search

`PlaceAutocompleteElement` replaces the hand-rolled search box in [builder.js](public/js/builder.js#L420-L460) — the debounce, the results list, the keyboard handling. The component manages session tokens internally, which is what keeps autocomplete on the free SKU; do not reimplement that.

Its markup will not match the existing `.hit` / `.hit-ctx` styling. Expect to restyle within what the component exposes, and to delete the old list markup from the panel.

### Routing

Rewrite `directions()` in [builder.js](public/js/builder.js#L73) against a new **`POST /api/route`** proxy on the origin, since you are making the server key.

```text
POST https://routes.googleapis.com/directions/v2:computeRoutes
X-Goog-FieldMask: routes.polyline.geoJsonLinestring,
                  routes.distanceMeters,routes.duration
body: { origin, destination, intermediates[],
        travelMode: "TWO_WHEELER",
        polylineEncoding: "GEO_JSON_LINESTRING" }
```

Three things differ from the Mapbox call it replaces:

- `POST` with a JSON body, not a `GET` with a coordinate string.
- The **field mask is mandatory and drives the price**. Ask only for the polyline, distance and duration; adding fields moves you up SKU tiers.
- `TWO_WHEELER` mode exists and suits this app better than anything Mapbox offered. Worth using deliberately rather than defaulting to `DRIVE`.

The proxy keeps the key IP-restricted rather than public, and gives a natural place to cache identical legs — the same two stops get re-routed constantly while a rider edits.

`duration` comes back as a string like `"1234s"`, not a number. Parse it.

### Other surfaces

- **`viewer.js`** — three `mapboxgl` references, all via `TBMap`. Should need little beyond the rewritten helpers.
- **`profile.js`** — its geocode call moves to the server proxy, since Geocoding is on the server key.
- **Shells** — `nativeViewHtml` and `builderHtml` swap script tags.

<!--| PAGE-BREAK -->

## Phase 4 — retire Mapbox

Once both viewers and the builder are on Google:

- Delete `public/js/main.js` (1,135 lines) and unify `/m/:slug` on one engine. `viewHtml` and `nativeViewHtml` in [src/index.ts](src/index.ts) collapse into one — both sources already render `concat(legs)`, so this is shell-level only.
- Drop `MAPBOX_TOKEN` and `MAPBOX_GL_VERSION` from config, `.env.example`, `docker-compose.prod.yml`, and the deploy guard in [utils/deploy/deploy.sh](utils/deploy/deploy.sh#L70).
- Delete `.gm-ui-hover-effect`'s "keep until Phase 4" comment — it is permanent now.
- Update [_AI_AGENT_PRIMER.md](_AI_AGENT_PRIMER.md), which describes a two-engine transition that will no longer exist.

## What you need to do in the console

### The server key — you asked for instructions

To be clear on terms: this is an **API key with an IP restriction**, not a service account. Service accounts are for Google Cloud APIs; Maps Platform uses API keys.

```bash
# 1. Your NAS's public egress IP — not its LAN address
ssh <nas-host> 'curl -s https://ifconfig.me'

# 2. Create the key, restricted to that IP and to three APIs
gcloud services api-keys create \
  --display-name="routeloop server" \
  --allowed-ips="<IP_FROM_STEP_1>" \
  --api-target=service=routes.googleapis.com \
  --api-target=service=geocoding-backend.googleapis.com \
  --api-target=service=static-maps-backend.googleapis.com

# 3. Read the secret out — create returns a resource name, not the key
gcloud services api-keys list --format="table(displayName,uid)"
gcloud services api-keys get-key-string <UID>
```

Paste it into `.env` as `GMAPS_SERVER_KEY`. It is already plumbed through `config.ts`, `deploy.sh` and `docker-compose.prod.yml`.

**Add your own workstation's IP too** while developing, or the proxy fails locally: `curl -s https://ifconfig.me`. And if the NAS is on a residential connection, an IP change silently breaks server-side calls while the browser key keeps working — it will look like a routing bug.

### Everything else

1. `gcloud auth login`, set account to `ziad@feralcreative.co`, set the project — the active project is currently `visa-knowledge-quiz-stage`.
2. Enable the five APIs and create the browser key ([docs/google-cloud-setup.md](docs/google-cloud-setup.md)).
3. **Create a Map ID** — Google Maps Platform → Map management → vector map. Advanced Markers do not render without one. Put it in `.env` as `GMAPS_MAP_ID`.
4. **OAuth client + consent screen**, console only, no API exists. Redirect URIs are in the setup doc. Confirm the scope list is exactly `openid` + `email` + `profile`.
5. **A Gmail app password** for magic-link SMTP, on an account separate from the OAuth client. Requires 2FA on that account.
6. Privacy policy and terms pages — required fields for a published external consent screen, and neither exists yet.
7. Per-API daily quota caps. A budget alert reports the money after it is gone.

<!--| PAGE-BREAK -->

## Verification

**Auth**, locally, then on stage before touching the prod Access policy:

1. Google sign-in end to end; confirm one `user_identities` row with `provider='google'` and no duplicate user.
2. Sign in with the same address by magic link; confirm it **links to the same user** rather than creating a second.
3. Redeem a magic link twice — the second must fail.
4. Wait out the 15-minute expiry and confirm rejection.
5. Request a link for an address with no account; response must be indistinguishable from the account case.
6. Hammer the request endpoint; confirm the rate limit engages.
7. `curl -H 'Cf-Access-Authenticated-User-Email: someone@else.com' /auth/google/callback` — must **not** produce a session. This is the regression test for the deleted header trust.
8. A brand-new account still lands `pending` → `/welcome`, and every gate from Sprint 2 still holds.

**Maps**, per surface:

1. An imported ride and a native ride both render on `/m/:slug` with identical markers, arrows and tooltip mileage columns.
2. Multi-route rides: per-route colors, legend, hover-dim.
3. Builder — click to add, search to add, drag, delete, reorder, save, reload. Saved geometry must round-trip byte-identical in shape.
4. Compare a re-routed leg's `distanceM` against the pre-migration value for the same two stops. Large divergence means a coordinate order bug, not a different router.
5. `/api/route` rejects a request without a session, and the server key never appears in any page source: `curl -s localhost:6686/builder | grep -c "$GMAPS_SERVER_KEY"` must be `0`.
6. Profile address geocoding still resolves through the proxy.
7. `npm run typecheck`, `npm run sass`, and a browser pass at 390px and 1440px.

## Risks

- **Coordinate order is the one that will bite.** Mapbox is `[lng, lat]`, Google is `{lat, lng}`, and `route_legs.geometry` stores Mapbox order. Get it backwards and the map still renders — just in the Indian Ocean, or subtly wrong at small offsets. Every conversion should go through a single named helper rather than inline literals, and step 4 of the map verification above exists specifically to catch it.
- **Advanced Markers silently need a Map ID.** Without `GMAPS_MAP_ID` the markers simply do not appear, with a console warning that is easy to miss.
- **Places session tokens.** The component handles them; a hand-rolled fallback would move autocomplete from free to $2.83/1,000 per keystroke without any visible symptom until the bill.
- **The Access removal window.** Between deleting the policy and deploying the code that stops trusting the header, the app is open. Deploy first, then pull the policy.
- **Free tiers shrink.** Dynamic Maps is 10,000 loads/month against Mapbox's 50,000, and Directions' 100,000 becomes Routes' 10,000. Quota caps before traffic, not after.
- **Scope.** These are two independent migrations sharing a branch. If something slips, auth is the one that can ship alone — the maps work is inert until the whole engine is switched.
