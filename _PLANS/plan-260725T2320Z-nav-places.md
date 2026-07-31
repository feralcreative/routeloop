# RouteLoop — changes from `_PLANS/changes-260725T2320Z.md`

## Context

Five requests from the owner. Items 1, 4, and 5 are presentation work over existing surfaces; item 2 is a new first-class entity and item 3 is the seam between them.

1. No obvious way home from the map/builder page — add global nav.
2. Saved **Places**: permanent, user-owned, categorized map markers, toggleable as layers, addable from the map, managed at `/places`.
3. Places carry a **default icon**, overridable when added to a given route.
4. Wire up four orphaned logo files.
5. An alpha splash modal pointing at GitHub issues, Signal, and the VMC Discord.

Two findings from exploration shape everything below.

**The app has two disjoint front ends.** `page()` in `src/views/layout.ts` serves `/`, `/login`, and `/dashboard` with ~35 lines of inline `CHROME_CSS` and never links the compiled stylesheet. The builder and both viewers build their own shells, link `main.min.css`, and render **no header at all** — which is exactly why there is no way home from a map page. The two systems carry different accent blues (`#06c` vs `$url: #1565c0`) and define `.btn` twice. Item 1 can't be fixed well without addressing this, and items 4 and 5 need one place to live.

**`points.routeId` is `NOT NULL` with FK cascade** — a point cannot exist without a route, and no user-owned, ride-independent table exists anywhere in the schema. Places will be the first of its kind.

### Decisions taken

| Question | Decision |
| --- | --- |
| What is a Place "category"? | **User-defined only** — the category owns the icon and color; places inherit both. No per-place role. |
| Sequencing | **Phase A** (items 1/4/5) ships first; **Phase B** (items 2/3) follows. |
| Splash frequency | Shows on load with a **"Don't show this again" checkbox**; only that persists a dismissal. |
| Nav scope | **Unify the shell** — one header, one CSS system, all pages. |

### Resolved external URLs (item 5)

| Link | URL |
| --- | --- |
| GitHub issues | `https://github.com/feralcreative/routeloop/issues` |
| Signal | `https://feral.ly/signal` |
| Discord | `https://discord.gg/5wqFRxqzxN` |

Confirmed via `gh repo view`: GitHub already serves the repo as `feralcreative/routeloop` with issues enabled. The **local remote still points at `tankbag-app`** — GitHub redirects, so nothing is broken, but re-point it: `git remote set-url origin https://github.com/feralcreative/routeloop.git`. Discord came from `vampiresmc.com` (not `vampires.com`).

<!--| PAGE-BREAK -->

## Phase A — nav, logos, splash

### A1. One CSS system

Fold `CHROME_CSS` into the SCSS build and give `page()` an unconditional `<link rel="stylesheet" href="/style/main.min.css">`. Nothing structural prevented this — `app.use('/style/*', serveStatic(…))` already serves it to any page.

Split the flat 945-line [style/main.scss](style/main.scss) into partials, keeping `main.scss` as the sole `@use` manifest so `npm run sass` and the Dockerfile are unchanged (`COPY style ./style` already picks up new files). Verified: only `style/main.scss` is tracked — `public/style/main.min.css` is gitignored and compiled at image build, so there is no committed artifact to keep in sync.

```text
style/main.scss          @use manifest only
style/_tokens.scss       vars + z-index ladder
style/_base.scss         reset, typography, links
style/_chrome.scss       ex-CHROME_CSS
style/_nav.scss          NEW — header, hamburger, drawer
style/_modal.scss        NEW — backdrop + dialog primitive
style/_map.scss          #map, #info-panel, tooltips, .tb-marker*
style/_builder.scss      .builder-panel
style/_toast.scss        #tb-toast, .tb-banner
style/_responsive.scss   the labeled //@ media ladder
```

`_tokens.scss` keeps every existing variable name so nothing breaks, and adds the z-index ladder as named vars (currently magic numbers across three files):

```scss
$z-map-panel: 1000; // #info-panel, unchanged
$z-header: 1200;
$z-nav: 1300;
$z-toast: 2000; // unchanged
$z-banner: 2100; // was 2001
$z-modal: 3000;
```

Delete the genuinely dead `.crater-lake`, `div.map-logo`, `div.panel-logo`, `$panel-logo-size`, and the never-toggled `.desktop`/`.mobile` helpers. **Keep `.gm-ui-hover-effect`** — `viewHtml()` still serves imported rides on Google Maps until Phase 4.

**The typography merge is the main regression risk.** `main.scss` sets `font: 400 14px/1.1em` on **`html`**, so `.panel-title { font-size: 3rem }` is currently 42px, not 48px. Make chrome the default and re-tighten for map pages at the `html` level so `rem` keeps its meaning:

```scss
html,
body {
  margin: 0;
  padding: 0;
  font: 400 16px/1.5 $font;
  color: $text;
}
html.map-page,
html.map-page body {
  font: 400 14px/1.1em $font;
}
```

Move `body { padding: 2rem }` and `max-width: 960px` off `body` onto a `.page-wrap` container so a full-bleed page can never inherit them. Replace `#06c` with `$url` and define `.btn` once, deleting the duplicate in `.builder-actions`.

### A2. Refactor `src/views/layout.ts`

```ts
export type PageOpts = {
  title: string                // WITHOUT the " — routeloop" suffix
  user: UserRow | null
  body: string
  variant?: 'chrome' | 'map'   // default 'chrome'
  bodyClass?: string
  navKey?: 'home' | 'rides' | 'builder' | 'places'
  head?: string
  scripts?: string
  tb?: Record<string, unknown> // becomes window.TB
  splash?: boolean             // default true
}
```

`page()` unconditionally emits doctype, `<html>` + variant class, meta, `<title>${esc(title)} — routeloop</title>` (centralizing the suffix currently duplicated in four shells), `SITE_ICON_LINKS`, the Lato link, the stylesheet, OG/Twitter meta, the site header, the splash markup, and `/js/site.js`. `variant: 'map'` adds the Mapbox GL CSS and skips `.page-wrap`.

Two supporting exports:

- **`jsonScript(varName, value)`** — required hardening, not a nicety. `JSON.stringify` is inlined raw into `<script>` in three places today ([src/index.ts](src/index.ts), [src/routes/rides.ts](src/routes/rides.ts)). Current values are safe, but Phase B puts user-authored strings near this path and a `</script>` breaks out. Escape `<`, `>`, U+2028/2029.
- **`panelShell({title, extraClass, contents})`** — extracts the `#info-panel` / `.collapse-toggle` scaffold copy-pasted three times.

Add **`src/config.ts`** for `MAPBOX_TOKEN`, `MAPBOX_GL_VERSION`, `GMAPS_KEY`, `PORT`, and the three alpha URLs. This kills the `MAPBOX_TOKEN` double declaration and the `v3.10.0` string hardcoded twice in `rides.ts` while a const exists in `index.ts` — they can currently drift.

`builderHtml()` must gain a `user` parameter; both `/builder` routes are behind `requireAuth`, so `currentUser(c)` supplies it.

### A3. Global nav

A module-private `siteHeader(user, variant, navKey)` renders a logo link, a hamburger button (`aria-expanded`, `aria-controls`), and a nav containing Home / Plan a ride / Your rides / **Places** (Phase B only — don't ship a link to a 404) / user + Sign out / "About this alpha". Signed-out: Home / Sign in / About.

On chrome pages the header sits in flow. On map pages it is `position: fixed` at `$z-header: 1200`, which clears `#info-panel` (1000) and Mapbox's in-map controls. Since `#map` is a full-viewport fixed canvas, the header must not eat drags:

```scss
html.map-page .site-header { pointer-events: none; }
html.map-page .site-logo,
html.map-page .nav-toggle,
html.map-page .site-nav { pointer-events: auto; }
```

Behavior goes in a new **`public/js/site.js`** (one IIFE, no deps, `defer`, loaded everywhere): toggle open/closed, close on Escape / outside click / link activation, focus the first link on open and restore to the toggle on close. Menus are not modal — no focus trap here, unlike the splash.

### A4. Logos

| Asset | Where |
| --- | --- |
| `logo-routeloop-horiz.svg` | Site header on every page, replacing the `<strong>routeloop</strong>` text wordmark. ~24px tall, explicit `width`/`height` to avoid CLS. |
| `logo-routeloop-vert.svg` | `/login` hero above the `<h1>`, and the alpha modal header. |
| `logo-routeloop-horiz@2x.png` | `og:image` / `twitter:image` — a real gap today; shared `/m/:slug` links have no card image. |
| `logo-routeloop-vert@2x.png` | Reserve for the PWA manifest; no Phase A change. |

Both SVGs hardcode `fill="#333333"`, so they cannot be CSS-tinted. Ship plain `<img>` and accept `#333` — it reads correctly on light chrome and on the translucent header pill over map tiles. **Do not use `filter:` hacks.** If a dark theme lands later, the fix is a one-time `fill="#333333"` → `fill="currentColor"` edit of the assets; that means modifying files the owner supplied, so confirm first.

### A5. Alpha splash modal

New `src/views/splash.ts` exporting `alphaSplash()`. URLs come from `src/config.ts` via env so they can change without a code edit; add all three to `.env.example`. Markup is a `.modal-backdrop` containing `role="dialog" aria-modal="true"`, the vertical logo, copy, the three links (`target="_blank" rel="noopener"`), a `Don't show this again` checkbox, and a `Got it` button.

Client logic joins `site.js`:

- localStorage key `routeloop.alphaSplash`, value a **version stamp** from a `ALPHA_SPLASH_VERSION` const. Bumping it re-shows the modal for everyone — free, and you will want it.
- On load, show unless the stored value matches the current version.
- Dismiss on button / Escape / backdrop click. **Only when the checkbox is checked** does it write to localStorage; otherwise it returns next load, which is exactly the requested behavior.
- **Real focus trap** here (~15 lines), cycling Tab within the dialog. This becomes the app's modal primitive, reused by Phase B's category editor.
- Wrap all localStorage access in try/catch — private mode throws, and a failure must mean "not dismissed", never a crash.

It appears on every page including `/m/:slug` for anonymous visitors, who are exactly who should know this is alpha. `splash: false` is the escape hatch.

### A6. Order of work

1. `src/config.ts` — constants first.
2. SCSS split; `npm run sass`; **visually diff all six pages before touching any TS.** This isolates the riskiest change.
3. `src/views/layout.ts` rewrite.
4. `src/views/splash.ts` + `public/js/site.js`.
5. `src/index.ts` — three shells onto `page()`.
6. `src/routes/rides.ts` — `builderHtml()` onto `page()`, thread `user` through.
7. `src/routes/auth.ts` + `src/routes/dashboard.ts` — titles, logo hero, `navKey`.
8. Delete untracked `style/main.css*` and `style/main.min.css*` litter.

<!--| PAGE-BREAK -->

## Phase B — Places

### B1. Schema

Two new tables in [src/db/schema.ts](src/db/schema.ts), plus one column on `points`.

```ts
place_categories
  id, owner_id -> users (cascade)
  name      varchar(60)  notNull
  role      waypoint_role  notNull default 'poi'   // the icon
  color     varchar(7)   notNull default '#1565c0'
  position  smallint     notNull default 0
  createdAt
  index (owner_id, position) · unique (owner_id, lower(name))

places
  id, owner_id -> users (cascade)
  category_id -> place_categories (cascade)  notNull
  name varchar(255) notNull · description varchar(2000)
  lat/lng doublePrecision notNull · address varchar(255)
  createdAt, updatedAt
  index (owner_id) · index (category_id) · lat/lng range checks

points
  + place_id -> places (ON DELETE SET NULL)   // nullable
```

Four decisions worth stating:

- **The icon is a `waypoint_role`, not a free string.** This reuses the 17 existing SVGs, `ROLE_META`, `markerElement`, and the `currentColor` tint machinery for zero new asset work — and makes item 3's override free (see B4).
- **`position` is indexed, not unique.** Routes get away with `uq_route_ride_pos` because they're full-replaced; categories reorder in place, and a unique constraint makes a swap impossible without a temp offset. Order by `position, id`.
- **`places.owner_id` is denormalized** (derivable via category) to make the layer query one hop. Always resolve the category with `ownCategory()` and take `ownerId` from that row — never from the request body.
- **`points.place_id` is `SET NULL`, not cascade.** This is load-bearing: a saved ride must never lose a stop because a bookmark was deleted. The point row already holds its own lat/lng/name/roles — a full snapshot — and just forgets its provenance.

Caps in `src/routes/places.ts`: `MAX_CATEGORIES_PER_USER = 30`, `MAX_PLACES_PER_USER = 2000`, both checked inside the create transaction.

### B2. API — new `src/routes/places.ts`

Mounted `app.route('/', placesRoutes)` after `withSession`. Ownership helpers `ownCategory` / `ownPlace` mirror `ownRide` ([src/routes/maps.ts](src/routes/maps.ts)) exactly — returning undefined for both "not yours" and "not found" so a 404 never confirms existence. Reuse `fields` and `firstIssue` from the same file, and `sanitizeText` from [src/maps/kml.ts](src/maps/kml.ts).

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/places` | `{categories, places}` — one call, the whole layer payload |
| POST | `/api/place-categories` | cap-checked |
| PATCH | `/api/place-categories/:id` | rename / recolor / change icon |
| DELETE | `/api/place-categories/:id` | 409 unless `?force=1`; UI offers "move places to X" first |
| PUT | `/api/place-categories/order` | `{ids:[…]}`, full-order replace in one tx |
| POST · PATCH · DELETE | `/api/places[/:id]` | cap-checked; owner from resolved category |
| GET | `/places` | HTML page, `requireAuth` |

All writes carry `requireAuthApi` + `requireSameOrigin`. **No auto-seeding** — an empty state offers three one-click starters (Home, Gas, Food) that POST real rows. Side-effecting GETs are a trap.

### B3. Places as toggleable layers

Markers are HTML `mapboxgl.Marker` elements, not Mapbox layers, and there is no group concept. **Keep HTML markers** so places look identical to route points — that similarity is the point of the feature — and add the missing abstraction to [public/js/map-common.js](public/js/map-common.js) in ~20 lines:

```js
// groupId -> { markers: [], visible: bool }
addMarkerToGroup(groupId, marker)
setGroupVisible(groupId, visible)   // element.style.display
clearGroup(groupId)
```

Namespace place groups `"tb-places-" + categoryId`, parallel to the existing `"tb-route-" + i`. Refactor `viewer.js` onto `setGroupVisible`, which removes the only ad-hoc marker-visibility code in the app.

A third marker kind — `markerElement(place, category.color, 'place')` → `.tb-marker-place`, styled to read as "saved, not part of this ride" (`opacity: .75` + white ring, full opacity via an `.is-in-route` modifier).

UI is a collapsible "Places" section in the builder's `#info-panel`: a master toggle plus one checkbox per category, using the `--route-color` CSS-var trick the route legend already uses. Persist to localStorage. **Create a category's markers on first enable and clear on disable** so 2000 places never means 2000 DOM nodes.

Places on the public viewer are **cut from v1** — they belong to the signed-in viewer, not the ride.

### B4. Add-to-route and the per-route override

**Item 3 falls out of the schema with no new model.** A place dropped into a route copies name / lat / lng / description and sets `roles = [category.role]` — that is the default icon. The rider then toggles roles on that row with the existing `.row-roles` picker — that *is* the override. No new column, no new UI.

Two consequences, stated deliberately:

- Recategorizing a place later **does not** change any saved route. Points are snapshots; a ride is a historical document.
- Deleting a place nulls `points.place_id`; the stop survives intact.

Server changes in [src/routes/rides.ts](src/routes/rides.ts):

- `stopSchema` gains `placeId` — **mandatory**, since Zod strips unknown keys and the round-trip would silently lose the link.
- `insertRideGraph` passes it through.
- Before insert, batch-validate that every non-null `placeId` belongs to the caller and **silently null out non-matches** rather than 400ing — a place deleted in another tab must not fail an unrelated save.
- The public `ride.json` **omits** `placeId`; it leaks internal ids for no viewer benefit.

Three entry points in the builder: a click-only popup on place markers with "Add as stop" / "Add as POI" (hover-dismissed popups make buttons unusable); a `+` per place row in the panel; and — **required for v1** — a ★ on each `.point-row` to save an existing stop as a place, which is the "add them to their saved Places from the map" half of request 2.

### B5. Collapse duplicated constants

Phase B adds a fourth consumer of the role cap, so unify now. `MAX_STOPS`, `MAX_POIS`, and `MAX_ROLES_PER_POINT` are currently duplicated as literals between `rides.ts` and `builder.js` (`< 4`, `>= 200`). Move them to one module and inject the client-relevant ones as `window.TB.limits`.

The DB check `ck_point_roles_max4` must keep its literal — drizzle's `sql` template parameterizes interpolations, which is invalid inside a `CHECK`. Leave a comment naming the other sites, and note the constraint name embeds the number.

### B6. Order of work

Schema → API (curl-test before any UI) → mount + nav link → `rides.ts` wiring → `map-common.js` primitives → `/places` page → builder integration → marker SCSS.

## Verification

**Phase A** — run `npm run sass:watch` and `npm run dev`, then walk the matrix of 6 pages × {signed in, signed out} × {desktop, ≤575px}:

- `/`, `/login`, `/dashboard`, `/builder`, `/builder/:id`, `/m/:slug` for **both** a native and an imported ride (the imported one still uses Google Maps).
- The map still drags and zooms **under** the fixed header.
- `#info-panel` collapse still works; `.panel-title` is still 42px.
- The builder's role picker, search, and save are unchanged.
- Splash shows once; unchecked dismissal returns next load; checked does not.
- Escape closes both nav and modal; Tab is trapped in the modal, not the nav.
- `npm run typecheck` clean.

**Phase B** — curl the API before building UI, following the existing gating tests: 401 unauthenticated, 403 on bad Origin, 404 for another user's id, 409 on non-empty category delete, cap enforcement. Then end-to-end in a browser: create categories, add places from the map, toggle layers, add a place to a route, save, reload, and confirm the route round-trips with `placeId` intact. Finally delete the source place and confirm the saved stop survives with `place_id` nulled.

Schema is push-only with no `drizzle/` directory. **Run `npx drizzle-kit push` without `--force` first and read the statement list**, and `pg_dump` prod beforehand — this is the first release where users hold data that cannot be reconstructed from an uploaded file. Consider switching to `drizzle-kit generate` with a tracked migrations directory at this point.

## Risks

- **Typography merge** (Phase A) is the top regression risk; the `html`-level variant class is the mitigation.
- Chrome pages will gain underlined links, since the global `a:link { text-decoration: none }` currently applies to map pages only by accident. Decide deliberately rather than discovering it.
- `viewHtml()` still loads the 1000-line legacy `public/js/main.js`. Route it through `page()` and change nothing else — it retires in Phase 4.
- Builder and server must deploy **together** in Phase B; an in-flight builder tab saving against the new server drops `placeId`.
- `places.owner_id` drifting from its category's owner — mitigated procedurally; a composite FK is the belt-and-braces option.

## Cut from v1

Places on the public viewer; drag-and-drop reorder; per-place icon override (the category owns it by decision); sharing a place list; KML place import; real Mapbox symbol layers and clustering; a map preview on `/places`; bulk edit.
