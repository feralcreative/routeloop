# TankBag sustainability

**Updated:** 2026-08-01

The durable record of what TankBag costs to run, what the market for it looks like, and which monetization paths are open. It pairs with the other planning docs and does not duplicate them:

- **This file**—the economics: cost curve, market size, and the decisions that follow from both.
- **[ROADMAP.md](../ROADMAP.md)**—the feature narrative. Several roadmap items have cost consequences; those are flagged here by number.
- **[STATUS.md](../STATUS.md)**—the current state and next steps.
- **[\_AI_AGENT_PRIMER.md](../../_AI_AGENT_PRIMER.md)**—architecture and load-bearing gotchas.

## Why this document exists

TankBag was built for the owner and his friends, and turning it into an extraction machine would ruin it. But it should not grow into a bill that cannot be paid, and it should at minimum pay for itself.

Those two goals are in tension only if cost control and revenue are treated as the same problem. They are not, and the central decision recorded below is to solve them separately.

## Scale expectations

Planning against realistic numbers rather than aspirational ones, since the two produce completely different architectures:

| Stage | Registered users | Monthly active | Timeframe |
| --- | --- | --- | --- |
| Now | A few dozen (friends and club) | ~20 | Today |
| Beta | A few hundred | ~100 | Next |
| Growth | A few thousand | ~900 | After that |
| Category leader | ~100K | See ceiling section | Aspirational |

Everything below is sized for the first three rows. The fourth is recorded as a ceiling, not a plan.

## Findings

### Hosting is fixed; maps are the variable cost

TankBag runs on a Synology NAS behind a Cloudflare Tunnel. That is a development-phase arrangement, not the long-term plan, but it means today's hosting is a fixed cost already paid and storage sits on owned disk.

The consequence matters more than it first appears: **`users.quota_bytes` (250 MB default) is protecting NAS space, not a cloud bill.** Bytes cost effectively nothing. Gating storage would therefore be a purely arbitrary paywall—the exact failure mode this project is trying to avoid. Storage caps stay as an abuse control and are explicitly not a monetization lever.

Essentially all present and future variable cost is Google Maps Platform.

### The Google Maps Platform pricing model

Google retired the universal $200 monthly credit in March 2025. Allowances are now per-SKU and **do not pool**—exhausting one does not borrow from another.

| SKU | Free per month | Rate beyond free | Driven by |
| --- | --- | --- | --- |
| Dynamic Maps (Maps JS) | 10,000 loads | $7.00 / 1k to 100k, then $5.60 / 1k | Every page that renders a map, including anonymous ride views |
| Routes (Compute Routes, Basic) | 10,000 calls | $5.00 / 1k | Building routes and dragging legs |
| Places Autocomplete | Session-billed | Free per keystroke with a session token | The search box |

Two expensive mistakes were already avoided and should not be regressed:

- `public/js/map-common.js` uses `AutocompleteSessionToken` and nulls it after the details fetch. Without session tokens, autocomplete bills roughly $2.83 per 1,000 **keystrokes**.
- `src/routes/routing.ts` sends a minimal `X-Goog-FieldMask`. The field mask is what Google prices the call on, and a wider mask silently moves the request into the Advanced ($10/1k) or Preferred ($15/1k) tier.

Both have explanatory comments in place. Keep them there.

<!--| PAGE-BREAK -->

### Routing dominates the bill, not map loads

This is the finding that most changes the plan, and it inverts the intuitive answer.

At category-leader scale, where a large anonymous audience views shared rides, Dynamic Maps loads dominate. **At TankBag's actual scale the audience is small and the users are heavy builders**, so the cost is driven by route computation instead. A serious multi-day trip is 20–30 legs, and every stop drag, reorder or reshape re-requests the affected leg. A single well-built trip can be 100+ Routes calls.

That ratio holds until the viewing audience substantially outnumbers the planning audience, which will not happen at a few thousand users.

The practical consequence is good news: **Routes is the SKU that already has a clean abstraction seam.** `POST /api/route` is a server-side proxy, so substituting a self-hosted router behind it is a contained change that never touches the client. The dominant cost is also the cheapest one to eliminate.

### The uncapped surface

`GET /m/:slug` and `GET /api/public/rides/:slug/ride.json` are unauthenticated by design, and every view renders a billable Dynamic Maps load.

**Cost therefore scales with strangers, not with users.** A single ride posted to ADVrider or r/motorcycles can exhaust the monthly free tier in an afternoon regardless of how few registered users exist, and rate limiting is roadmap item 11, unbuilt. The per-API daily quota caps in roadmap item 1 remain an unchecked box.

At current scale this is the only meaningful billing risk, and it is entirely an accident risk rather than a growth cost.

### The leg cache does not survive scale

`src/routes/routing.ts` holds a 500-entry in-process `Map`. It is the right call today and worth nothing later: it is lost on every container restart and, being per-process, cannot be shared across horizontally scaled instances. Traffic projections beyond the beta stage should assume a low hit rate until it moves to shared storage.

## Cost at each stage

Modeled, not measured. Assumes roughly 12 map-rendering sessions per active user per month, 1.5 trips built per active user per month at ~100 Routes calls each, and a public-view audience proportional to the user base.

| Stage | Map loads | Routes calls | Monthly Google cost |
| --- | --- | --- | --- |
| Now (~20 active) | <1,000 | <3,000 | $0 — comfortably inside every free tier |
| Beta (~100 active) | ~4,000 | ~15,000 | ~$25 |
| Growth (~900 active) | ~31,000 | ~135,000 | ~$770 |

The shape worth internalizing: **nothing costs anything until the low thousands of users, and then routing becomes ~80% of the bill.**

At the growth stage, roughly $800/month needs about 110 subscribers at MyRoute-app's €6.95 price point—a 3–4% conversion against 3,000 users, which is squarely at the freemium norm.

But self-hosting the router at that stage removes ~$625 of that $770 and drops the target to roughly 20 subscribers. **Migrating routing is worth about 100 subscribers of conversion pressure.** That is the highest-leverage economic decision on the roadmap, and it is an engineering task rather than a product compromise.

<!--| PAGE-BREAK -->

## The ceiling

MyRoute-app is the category leader and the closest comparable. Panel estimates for June 2026:

| Metric | Similarweb | Semrush |
| --- | --- | --- |
| Monthly visits | 350.2K | 277.5K |
| Global rank | #96,303 | — |
| Category rank | #14, Motorcycles (NL) | — |
| Pages per visit | 6.41 | — |
| Average visit duration | 5:20 | — |
| Bounce rate | 32.3% | — |

Traffic was down 12.99% month-over-month, so the category reads flat to declining rather than growing.

Audience geography: Netherlands 23.2%, UK 17.4%, US 12.2%, Germany 11.0%, Belgium 9.4%. Demographics: 81% male, largest cohort 45–54.

Four things follow.

1. **This is the realistic ceiling, and it is modest.** The category leader draws ~300K visits per month and ranks around #96,000 globally. Reaching that would make TankBag approximately the size of MyRoute-app.
2. **The US is underserved.** MyRoute-app is Europe-dominant, with the US a distant third at ~37K visits per month across the entire country. That is the most encouraging number in the dataset, and it is the segment TankBag is native to.
3. **Population is not addressable market.** Northern California has tens of thousands of motorcyclists, but the slice that uses a desktop route planner is far smaller—the global leader touches perhaps 10–20K people in the whole US. That is an argument for expanding the category rather than for assuming the audience is already waiting.
4. **The audience can pay.** A 45–54-year-old with a touring bike is not price-sensitive about a €7/month hobby tool. MyRoute-app's pricing sets the anchor: Basic free, Explorer €3.95/mo, Gold €6.95/mo, Lifetime €199.

Caveats worth carrying: these are panel extrapolations, easily ±30–50% in absolute terms, though two independent methods landing within 25% of each other is reassuring. Visits are not users. MyRoute-app also runs a separate mobile navigation app that does not appear in web traffic at all, so their true footprint is larger than these figures.

## Decisions

### Separate cost control from revenue

This is the load-bearing decision, and everything else follows from it.

**Cost control is an engineering problem.** GCP per-API daily quota caps, rate limits on the public viewer, and a view ceiling on shared rides. Solved in code, it never touches what riders experience, and the worst case becomes "the gallery is down for a day" rather than an unbounded invoice.

**Revenue is a separate and much smaller problem**, addressed on value rather than on relief from artificial pain.

Conflating the two is what produces a deliberately crippled free tier. Do not use cost caps as the paywall.

### Do not monetize before the growth stage

Through beta the bill is a rounding error. Introducing a paywall while the app costs $25/month would be solving a problem that does not exist, at the cost of the thing that makes the app worth using.

The trigger for acting on any of the revenue decisions below is **the growth stage, or the first month the Google bill exceeds roughly $100**, whichever arrives first.

### Sell Expand, not capacity

When the time comes, the paid line is **Expand plus batched Google Maps links** (roadmap item 4).

The reasoning:

- It is the feature the owner personally misses from MyRoute-app, and the direct answer to the 10-waypoint cap the entire vision is built around.
- It is a hand-off-time transform over `route_legs.geometry` that is already stored, so it costs nothing per use.
- It is purely additive. The free tier still plans, shares and views entire trips with no limits, so nothing about the free experience gets worse when the paid tier appears.

<!--| PAGE-BREAK -->

### Tour operators are freelance engagements, not a SaaS tier

The white-label idea (`jimsmototours.tankbag.app`) is worth pursuing, but priced and delivered as consulting—a setup fee plus a small monthly—rather than built out as a product line.

What changed this assessment: roadmap items 7 (rider roster, invites, per-ride RSVP, cost splitting from stored payment handles) and 10 (hotel confirmation numbers, check-in/out times, gate codes, per-role stop detail) **are** the tour-operator feature set, and both are already planned for the friends-and-family use case. The `can_manage_riders` capability flag exists in the schema today. So the incremental build is a subdomain and a logo slot, not a roadmap diversion.

At the growth stage, five operators covers the entire Google bill.

### Treat vendor choice as the primary cost lever

Marginal cost per user is a vendor decision, not a law of physics. Self-hosted routing (Valhalla, OSRM or GraphHopper over OSM) converts the dominant variable cost into a fixed one. Self-hosted tiles (Protomaps or OpenMapTiles) does the same for the remainder, at a few hundred a month flat regardless of user count.

Note the precedent: MyRoute-app sells TomTom and HERE maps **as a Gold-tier feature**, putting per-use-billed vendors behind the paywall precisely because they cost per use.

**This is not a call to migrate now.** All-Google is correct for the current stage, and the Phase 0 search-quality gate that justified it was real. But two things follow:

1. **Keep the seam.** Routing already has one at `POST /api/route`. Protect that boundary—it is the cheapest exit from the largest cost. Tiles are the coupled part, since `google.maps.importLibrary` is threaded through `map-common.js`, `builder.js` and `viewer.js`, and that migration would genuinely hurt.
2. **Reframe roadmap item 1.** "Retire the last Mapbox dependency so the stack is single-vendor" is written as debt cleanup. Being single-vendor on a per-call-billed provider is a strategic risk, not debt. Deleting the dead config is fine; deleting the *habit* of a vendor abstraction is not.

### Price roadmap item 9 before building it

Discovery and public profiles converts map loads from a function of the user base into a function of the internet. It is the one roadmap item capable of producing a bill that was never chosen, and it is dangerous at any user count. Build the caps first.

## Rejected

**Offline maps as the paid feature.** Investigated and ruled out. Google Maps Platform terms prohibit pre-fetching, caching, storing or rehosting Maps content, and the Map Tiles API may not be used offline at all. The only exception is a limited cache of lat/lng, distance, duration and ETA values for up to 30 consecutive days for latency reasons. Shipping offline maps would require a tile vendor that licenses it—which is Mapbox, the dependency roadmap item 1 removes. Revisit only if the self-hosted tile migration happens.

**Storage quotas as a paywall.** See "Hosting is fixed; maps are the variable cost" above. The disk is owned, so the cost being gated is imaginary.

**Ad-supported free tier.** Not wanted; recorded so the question is closed rather than merely unasked.

## Open questions

- What is actual current usage against each SKU's free tier? Everything above is modeled. The GCP billing console is the source of truth and has not been read.
- How many Routes calls does a real trip build actually generate? The 100-call estimate drives the entire growth-stage projection and is the single assumption most worth measuring.
- Where does the leg cache move when the NAS does—Redis, Postgres, or a CDN in front of `/api/route`?
- What hosting replaces the NAS, and at what fixed monthly cost?

## Actions

Ordered by value, highest first.

- [ ] **Set per-API daily quota caps in the GCP console.** Roadmap item 1, still unchecked. Roughly twenty minutes of console work, and until it is done the downside is unbounded while the upside is a nice gallery. Nothing else in this document matters as much at current scale.
- [ ] Instrument Routes call volume per saved ride, so the growth-stage projection rests on a measured number rather than an assumption.
- [ ] Read current usage per SKU in the GCP billing console.
- [ ] Rate-limit `GET /m/:slug` and `GET /api/public/rides/:slug/ride.json` (roadmap item 11).
- [ ] Add privacy policy and terms pages—already required by roadmap item 1 to publish the OAuth consent screen past 100 users, and a prerequisite for ever taking payment.
- [ ] Move the leg cache to shared storage before the first horizontally scaled deploy.
- [ ] Evaluate self-hosted routing when the Google bill first exceeds ~$100/month.

## Sources

Retrieved 2026-08-01. Maps pricing tiers move, and which Routes tier a call lands in depends on the field mask—verify against the console before planning around these figures.

- Google Maps Platform pricing: <https://developers.google.com/maps/billing-and-pricing/pricing>
- Per-SKU free tier announcement: <https://mapsplatform.google.com/resources/blog/start-building-today-with-up-to-10-000-monthly-free-calls-per-product/>
- Billing and pricing FAQ (credit and volume discount changes): <https://developers.google.com/maps/billing-and-pricing/faq>
- Google Maps Platform Terms of Service: <https://cloud.google.com/maps-platform/terms>
- Map Tiles API policies: <https://developers.google.com/maps/documentation/tile/policies>
- Similarweb, myrouteapp.com: <https://www.similarweb.com/website/myrouteapp.com/>
- Semrush, myrouteapp.com: <https://www.semrush.com/website/myrouteapp.com/overview/>
- MyRoute-app Routeplanner plan comparison: <https://info.myrouteapp.com/compare-routeplanner/>
