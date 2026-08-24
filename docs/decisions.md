# Decisions

Why the load-bearing choices were made, what was rejected, and what would have to be true to revisit them. Read this before undoing something that looks arbitrary. Operating rules are in [AGENTS.md](../AGENTS.md); how the pieces fit is in [architecture.md](architecture.md).

## Mapbox to Google Maps, 2026-07-30

**The driver was place-search quality, not rendering.** The reason it was a whole-engine swap rather than a search swap is that Google's terms forbid displaying Places content on a non-Google map, so "keep Mapbox rendering, use Google search" was never available. The full cost analysis that preceded the decision is preserved below.

It cost one file rather than three because `public/js/map-common.js` already owned every vendor call. The Mapbox version had left marker construction to its callers, which is exactly why the earlier engine change touched three.

`TWO_WHEELER` looks like the obvious travel mode for a motorcycle app and does not work in the United States—the Routes API answers HTTP 200 with an empty body. `DRIVE` is deliberate; see [debugging.md](debugging.md).

## Retiring the second viewer, 2026-08-01

`public/js/main.js` was 1,135 lines of `google.maps` that predated everything else, served imported rides on their own shell, and read `window.MOTO` rather than `window.TB`. It survived the Mapbox era as the reference implementation for the port _back_ to Google. Once that was done its remaining job turned out to be already handled: `ride.json` has served both sources identically since the timeline work added per-leg spans, so an imported ride is simply one day with one leg. Retiring it was flipping a conditional and deleting a file, not porting a renderer.

## `drizzle-kit push` to generated migrations, 2026-08-10

`push` left no artifact, so a schema change existed only in the database it was run against: it reached neither the second dev machine nor a reviewer's diff, and resurfaced as a 500 on whichever machine had not run it. `migrate` also cannot prompt, which matters more than it looks—`push`'s interactive questions are what made the deploy step unrunnable over SSH and what made `--force` tempting, and `--force` means "answer yes to everything", including "do you want to truncate the users table?". Full reasoning and the baseline procedure: [database.md](database.md).

The dated files in `utils/deploy/sql/` are the `push`-era record of what ran against production. They stay as history; new schema work does not go there.

## `ride > day > leg > stop/POI`, settled 2026-08-09

The `routes` table was renamed to `days` because every rider-facing surface already said "day"—the builder slider, the viewer legend, `DAY_COLORS`, the `dNN` filename field—while the code said "route", and "route" was simultaneously the import copy's word for a whole ride and the ~130 `app.route()` identifiers that mean HTTP handlers. "Route" now means only a path, or a route _file_ from another app. `route_legs` keeps its name because the route there is the path a day traces.

## A POI is on the route, 2026-08-24

Reported as a bug: a new day with a start point and one POI drew two dots and no line. It was not a bug—a POI was defined as "near the route and does not affect routing", so there was nothing the router had been asked to join—but the definition was wrong. A POI is somewhere you will at least ride BY: an address, or a spot in the middle of nowhere. It is always part of the route; it just is not necessarily somewhere you stop.

So `legs[i]` joins `points[i]` to `points[i+1]` for both kinds, and `kind` means only "do I stop here". The second index space that existed to convert between a point's position in the day and its ordinal among the stops is gone, and with it `stopIdx()`, `stopOrdinalAt()`, the projection of POIs onto the day's track, and the `poiDistsM` argument every schedule caller had to thread through. `stopsOf()` survives for the four surfaces that genuinely count stops: `rides.stop_count`, the roadbook's numbered rows, the Maps hand-off, and the at-least-one-stop rule.

**Rejected: making POIs shaping vias on their enclosing leg.** It is a far smaller change—mostly one function—and it keeps the leg array counting in stops. It also does not fix the report: a POI before the first stop or after the last one still routes nothing, so a start plus one POI still draws no line, which is the exact case that prompted this.

**Rejected: a third kind.** Keep POI meaning an off-route landmark and promote the ephemeral shaping waypoint to a real point kind. It preserves the ability to pin something genuinely off the road, at the cost of three kinds in the vocabulary, the row menu, and the icons. The premise did not hold: an off-route landmark is not what the word was being used for.

**Consequences accepted, not to be filed as defects.** Adding a POI is a Routes request now, where it used to be free. A day's leg count is bounded by `MAX_POINTS` (400) rather than `MAX_STOPS` (200), so up to 399 legs and 399 `route_legs` rows. `ride.json` lost the deliberate two-array `stops`/`pois` split, because the schedule walks points and legs together and two arrays cannot carry the order. The Google Maps hand-off now sends both kinds—excluding POIs would send the rider down a different road than the builder drew. And the native format went to 5, the first bump that is not a rename: a v4 file's `stops - 1` legs are re-cut from its own track at every point.

## The export filename carries four fields and no more

The convention exists because GPX and KML cannot hold a **date**, and that is the field doing the work. The recurring temptation is to keep adding fields—roles, colors, dwell—which turns a filename into a second, weaker serialization format competing with Routeloop JSON. Visibility and timezone are excluded specifically: a file named `public` that publishes a ride on import is a footgun, and a filename claiming a zone would invent one.

## Turnstile, and why it is off

Cloudflare Turnstile guards uploads and saves but is feature-flagged off until keys are set, so an unconfigured environment is not silently unprotected-looking-protected. Cloudflare **Access** was removed from the codebase entirely on 2026-07-30—it is billed per seat and could not survive open signups. The Access _policy_ still exists at the Cloudflare edge and is pure redundancy; the app has not read the header it injects since that date.

## Qlty over SonarCloud, 2026-08-03

SonarCloud reported 258 open findings, of which 86 were shell style in the deploy scripts and 31 were optional-chaining nudges, against 16 real bugs. Nobody reads 258 of anything. Only the two secret scanners block; everything else comments. The reasoning per plugin, including why SCSS is excluded from prettier there, is in `.qlty/qlty.toml`.

## Appendix: auth and place-search cost analysis, 2026-07-26

Written before either migration, as analysis for a decision with nothing yet implemented. Both recommendations were followed on the auth side; the search side went to Google rather than trying Mapbox Search Box first. Retained because the cost model and the Apple-specific hazards are still the best record of what was weighed.

Two questions, both of which turn out to have a single dominant factor rather than a close trade-off.

1. Multi-provider passwordless auth (Google, Apple, magic link) with a small audience now and an open door later.
2. Whether to move place search from Mapbox to Google, and what that costs at 100 / 1,000 / 10,000 / 100,000 users.

### Summary

**Auth.** Cloudflare Access cannot be the long-term answer at any price you would accept—it is billed per seat, at $7/user/month for _every_ user once you pass 50. It is an employee-access product being used as a consumer identity system. Move authentication into the app now, keep `users.status` as the capacity lever, and delete the Access trust path in the same change.

**Search.** Google Places is not a drop-in upgrade: Google's terms forbid displaying Places content on a non-Google map, so "keep Mapbox rendering, use Google search" is not an option. The realistic choices are switching the whole map engine to Google, or fixing the search quality inside Mapbox by moving from the Geocoding API to the Search Box API—which is the product actually designed for business and POI search, and is almost certainly the real cause of your dissatisfaction.

<!--| PAGE-BREAK -->

### Part 1—Auth

#### The cost that decides it

Cloudflare Zero Trust is free for up to 50 users. Past that, the pay-as-you-go plan is **$7 per user per month applied to all users**—there is no partial billing, so user 51 moves the whole roster onto the paid rate.

| Users   | Cloudflare Access | App-level auth (Arctic + magic link) |
| ------- | ----------------- | ------------------------------------ |
| 50      | $0                | $0                                   |
| 100     | $700 / mo         | ~$0                                  |
| 1,000   | $7,000 / mo       | ~$0                                  |
| 10,000  | $70,000 / mo      | email only, roughly $1–10 / mo       |
| 100,000 | $700,000 / mo     | email only, roughly $10–100 / mo     |

App-level auth has no per-user license cost. The only variable is transactional email for magic links, which is fractions of a cent per message.

#### What you already have

More than it looks like. The pieces for this were built and then half removed:

- `sessions`—server sessions keyed by the SHA-256 hash of the browser token. Provider-agnostic already; nothing about it assumes Cloudflare.
- `user_identities`—a `(provider, provider_user_id)` unique index with a `provider` enum. This table exists specifically so one user can hold several login methods. It needs two new enum values, `apple` and `email`, and nothing else.
- `users.status`—built this sprint. This is your audience-size control, and it is independent of _how_ someone authenticates. Keep it regardless of what you choose here.
- `arctic`—the OAuth2 client library that was uninstalled when Access landed. It covers Google, Apple, GitHub, Microsoft and others behind one interface.

So the work is: reinstate Arctic, add an Apple provider, add a magic-link table and two routes, and delete the Access bridge. The user model does not change.

#### Magic link

One new table, following the `sessions` pattern exactly—store the hash, never the token:

```text
login_tokens
  id          varchar(64) PK      -- sha256 of the emailed token
  email       varchar(255) notNull
  expiresAt   timestamp notNull   -- 15 minutes is typical
  consumedAt  timestamp           -- single use; set on redemption
  createdAt   timestamp notNull
  index (email, createdAt)        -- for rate limiting
```

Three things that are easy to get wrong and expensive to get wrong late:

- **Single use, short expiry.** Set `consumedAt` inside the same transaction that creates the session, or a forwarded email is a replayable credential.
- **Rate limit per email and per IP.** Without it the endpoint is a free spam cannon pointed at arbitrary inboxes, and your sending domain pays for it.
- **Do not reveal whether an address has an account.** The response is identical either way; only the email content differs.

#### Apple, specifically

Sign in with Apple is the fiddliest of the three, and worth knowing before you commit:

- The client secret is a **signed JWT you generate**, not a static string, and Apple caps its lifetime at six months. That is a recurring calendar item, and a silent total auth outage when it lapses. Generate it at boot from a stored private key rather than pasting a literal into `.env`.
- Apple returns the user's **name only on the very first authorization**, never again. Miss it and it is gone for that account permanently.
- Apple posts back with `response_mode=form_post`, so the callback is a POST, not a GET like Google's. Your CSRF `requireSameOrigin` gate will reject it as written—it needs an explicit exemption on that one route.
- Apple's private relay hands you a `@privaterelay.appleid.com` address. Treat it as a real address; do not try to match it against a Google identity by email.

#### The migration hazard

This one is worth stating on its own because it is a full authentication bypass if missed.

`accessEmail()` in `src/auth/access.ts` (deleted) trusts the inbound `Cf-Access-Authenticated-User-Email` header. That is safe _only_ because Cloudflare Access sits in front of `/auth/cloudflare` and strips or sets it. The moment Access stops protecting that route, anyone who can reach the origin can mint a session for any address by setting a header.

**Delete the header trust in the same commit that removes the Access application.** Not before, not after. The same applies to the `DEV_AUTH_EMAIL` fallback, which is currently guarded only by `APP_ORIGIN` not being HTTPS.

#### Recommendation

Build it now, as you suggested. The reasoning is not that Access is bad—it is that Access is billed per seat, so the migration is not optional, only delayed. Doing it now costs a sprint. Doing it after you open signups means migrating live accounts across an identity boundary, which is materially harder.

Keep `users.status` as the gate. That is what lets you open signups on your own schedule without touching auth again: the NAS capacity limit becomes a policy you enforce in a column, not a license you buy.

<!--| PAGE-BREAK -->

### Part 2—Place search

#### The constraint that comes before cost

Google Maps Platform terms prohibit using Google Maps Core Services with, or near, a non-Google map. Displaying Places content on a Mapbox map is explicitly called out as not permitted.

That removes the option you were probably considering—keeping Mapbox GL for rendering and calling Google Places for the search box. The real choices are:

1. Stay on Mapbox and fix search quality with the right Mapbox product.
2. Move the entire map engine to Google: rendering, search and directions.

There is no supported middle path.

#### You may be comparing the wrong Mapbox product

The builder currently calls the **Geocoding v6 forward** endpoint (the `geocode` call in `public/js/builder.js`). Geocoding is an address-resolution service—it is built to turn "1600 Pennsylvania Ave" into a coordinate, not to find "coffee near this pass."

Mapbox's product for business and POI search is the **Search Box API**, which is session-based, POI-aware and interactive-autocomplete oriented. Before concluding Mapbox loses to Google on quality, it is worth trying the product that is actually aimed at the thing you are doing. This is a contained experiment—one endpoint swap in one file.

#### Cost model

Cost scales with **usage, not user count**, so everything below rests on an assumed usage profile. Adjust this first if it looks wrong for your riders.

Per active user per month:

- **16 place searches**—two rides planned, eight searched stops each
- **10 map loads**—builder plus viewer sessions
- **40 Directions requests**—seven legs, re-routed as stops are edited

| Users   | Searches / mo | Map loads / mo | Directions / mo |
| ------- | ------------- | -------------- | --------------- |
| 100     | 1,600         | 1,000          | 4,000           |
| 1,000   | 16,000        | 10,000         | 40,000          |
| 10,000  | 160,000       | 100,000        | 400,000         |
| 100,000 | 1,600,000     | 1,000,000      | 4,000,000       |

#### The comparison

|                           | Mapbox as built (Geocoding) | Mapbox + Search Box   | Google (full switch)                 |
| ------------------------- | --------------------------- | --------------------- | ------------------------------------ |
| **100 users**             | **$0**                      | **$0**                | **$0**                               |
| **1,000 users**           | **$0**                      | **~$155**             | **~$180**                            |
| **10,000 users**          | **~$895**                   | **~$2,660**           | **~$3,330**                          |
| **100,000 users**         | **~$9,400**                 | **~$21,000**          | **~$25,000–35,000**                  |
| Search quality for POIs   | Weakest—address-oriented    | Purpose-built for POI | Best available                       |
| Free tier, search         | 100k geocodes               | 2,500 sessions        | Autocomplete sessions free           |
| Free tier, map loads      | 50,000                      | 50,000                | 10,000                               |
| Free tier, directions     | 100,000                     | 100,000               | 10,000                               |
| Can keep current renderer | Yes                         | Yes                   | **No—full rewrite**                  |
| Terms allow mixing        | n/a                         | n/a                   | **No**                               |
| Migration cost            | None, it is live            | One endpoint          | Both viewers, builder, all client JS |

Unit rates behind those figures:

| Service            | Mapbox                                                                                         | Google                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Interactive search | Geocoding $0.75/1k after 100k free · Search Box $11.50/1k after 2,500 free, to $6.60 at volume | Autocomplete session free when closed by a Place Details call       |
| Place detail       | included                                                                                       | Place Details $5/1k (Essentials, 10k free) to $17/1k (Pro, 5k free) |
| Map loads          | $5/1k after 50k free, to $2.50 at volume                                                       | Dynamic Maps $7/1k after 10k free                                   |
| Directions         | $2/1k after 100k free, to $1.20 at volume                                                      | $5/1k Essentials after 10k free · $10/1k Advanced                   |

#### Reading the table

**Below roughly 1,000 users none of this matters.** Every option is free or close to it. Choosing on cost at your current scale is optimizing a rounding error—choose on quality and on migration risk.

**Google is not dramatically more expensive at scale**, which is the surprise. It is ~20% above Mapbox-with-Search-Box at 100,000 users. Google's free tiers are much smaller, but its session-based autocomplete is genuinely free, which offsets most of the difference. Cost is not the argument against Google.

**The argument against Google is the switching cost and the lock-in.** It means rewriting both viewers, the builder, and every piece of client JS that touches `mapboxgl`, then being unable to mix providers afterwards. The terms make that a one-way door.

**The Place Details tier is the biggest unknown in the Google column.** If the fields you need (display name, formatted address) fall in Pro rather than Essentials, that line goes from $5 to $17 per 1,000—roughly $19,000/month more at 100,000 users. Verify the field tiers before taking Google seriously.

#### Recommendation

Try Search Box before switching engines. It is one endpoint in one file, it keeps every option open, and it directly tests the hypothesis that the quality gap is Google-versus-Mapbox rather than geocoder-versus-search-product. If Search Box closes the gap, you keep a cheaper stack, a renderer you already know, and the freedom to change your mind later.

If Search Box still disappoints, then the Google question becomes real—and it should be decided as "do we move the whole map engine to Google", because that is what the terms require, not as a search-provider swap.

<!--| PAGE-BREAK -->

### Confidence and gaps

Verified against primary sources this session:

- Cloudflare Zero Trust seat pricing and the 50-user free tier
- Google per-SKU pricing and free allowances for Autocomplete, Place Details, Dynamic Maps and Directions
- Mapbox pricing and free tiers for Search Box, Geocoding, GL JS and Directions
- Google's prohibition on using Places content with a non-Google map

Not verified, and load-bearing if you act on it:

- **Which Place Details field tier you would actually need.** The pricing page does not document field-to-tier mapping. This is the largest single swing in the Google column.
- **The usage profile.** Searches, map loads and Directions calls per user are my estimates, not measurements. Instrument the current app before trusting any figure past 1,000 users.
- **Volume-tier blending above 100,000 users.** Both vendors step rates down and both negotiate at that scale, so the 100,000-user row is indicative only.
- **Email provider pricing** for magic links. The order of magnitude is right; the specific figure is not researched.
- **Mapbox Search Box preview pricing.** Mapbox currently shows a lower introductory rate ($3/1k, 500 free) alongside standard pricing. The table uses standard rates, on the assumption that preview pricing ends.

### Sources

- [Cloudflare Zero Trust pricing](https://zerotrustcost.com/cloudflare-zero-trust-pricing)
- [Cloudflare Access pricing](https://costbench.com/software/ztna/cloudflare-access/)
- [Google Maps Platform core services pricing](https://developers.google.com/maps/billing-and-pricing/pricing)
- [Places API usage and billing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing)
- [Autocomplete and session pricing](https://developers.google.com/maps/documentation/places/web-service/session-pricing)
- [Google Maps Platform Terms of Service](https://cloud.google.com/maps-platform/terms)
- [Google Maps Platform Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)
- [Mapbox pricing](https://www.mapbox.com/pricing)
