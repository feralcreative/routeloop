# Routeloop roadmap

The durable plan for where Routeloop is going. It pairs with two other docs and with GitHub Issues; none of them duplicates the others:

- **The code**—the actual source of truth, above everything on this list. This file is a thinking surface, not a spec or a commitment: ideas get tried, abandoned and replaced without it being edited first. Where it conflicts with what shipped, or uses a name the code no longer uses, **the code is right and this file is out of date**. Nothing here should ever be cited as evidence that something is planned, required, or already decided.
- **This file**—the narrative: the vision, the phases, and why each matters. It changes slowly.
- **[STATUS.md](STATUS.md)**—the current state and the very next steps. It moves fastest and wins wherever it disagrees with this file.
- **[AGENTS.md](../AGENTS.md)**—the operating rules, the commands and the load-bearing gotchas. Read it before writing code.
- **GitHub Issues**—the pickup-able units of work. Most roadmap items below should become one issue each; the ones tagged _good first issue_ are collected at the bottom.

## How to read this

Each roadmap item lists a **Goal**, the **Work** as a checklist, the code it **Touches**, and a **Status**:

- **shipped**—done and deployed.
- **in progress**—partially built; see STATUS.md for the exact edge.
- **next**—unblocked and worth doing soon.
- **planned**—wanted, not yet scheduled.

If you are a new contributor, jump to [Working in this repo](#working-in-this-repo) first.

## Entries changed, and the issues that still need it

When an entry here is edited, the GitHub issue it maps to usually says the same stale thing—the issue was written from the entry. This table is the running list of edits whose matching issue has **not** been made yet. Delete a row once the issue is updated.

### 2026-08-30: one new item, from a rider who does not have a fuel tank

| What changed | Where |
| --- | --- |
| **New**: find a stop that refuels, feeds and entertains near the end of range. Raised by an electric-motorcycle rider and deliberately scoped **fuel-type agnostic**—a gas rider has the same problem with a shorter stop | item 33 |
| **Recorded**: `evChargeAmenitySummary` is Enterprise + Atmosphere, **$40/1000 with a 1,000-call free cap**—the priciest thing this app would touch. The design fetches it only when a rider opens a candidate | item 33 |
| **Recorded**: Nearby Search (New) **cannot filter on EV options**; Text Search (New) takes `evOptions` with `connectorTypes` and `minimumChargingRateKw`. Verified against Google's docs 2026-08-30 | item 33 |

**Item 33 has no GitHub issue.** It is the only entry added since the 2026-08-24 audit filed the previous eleven.

### 2026-08-24: an audit, and eight commits this file had never heard of

**Read this before trusting any status line above.** The roadmap was audited against the code on 2026-08-24 and was behind by one whole phase plus a branch of work. Three things were corrected here and three issues were edited on GitHub the same day.

| What changed | Where |
| --- | --- |
| **Corrected**: item 26 read "planned" for a week after rider feedback shipped ([#108](https://github.com/feralcreative/routeloop/pull/108), 2026-08-17) | item 26, and phase 3 of "The road to beta" |
| **Corrected**: phase 3 is done, so **phase 2 is the only open phase** and [#13](https://github.com/feralcreative/routeloop/issues/13) is the next pickup | "The road to beta" |
| **Corrected**: the test count, 869/37 → 1,240/52 | the 2026-08-10 table row for item 12, and "Where things stand" |
| **Edited on GitHub**: [#16](https://github.com/feralcreative/routeloop/issues/16) test-suite and CI boxes ticked, with the CI line rewritten to say what actually runs—typecheck and tests on Node 22 and 24, **no SCSS build** | issue only |
| **Edited on GitHub**: [#49](https://github.com/feralcreative/routeloop/issues/49) and [#23](https://github.com/feralcreative/routeloop/issues/23) retitled off the pre-rename vocabulary, the last two of the three flagged on 2026-08-15 | issue only |

**EIGHT COMMITS ON `fix/map-mechanics` HAVE NO ROADMAP ITEM AND NO ISSUE.** They were raised directly in conversation and built the same day, which is a legitimate way to work here and is exactly why nothing on either tracking surface knows about them. Listed so the next reader does not go looking:

- **A POI is part of the route** (`07f9820`)—`legs[i]` joins `points[i]` to `points[i+1]` whatever kind either end is. The largest change to the data model since the `routes`→`days` rename, together with the one below.
- **A day is one ordered list of points** (`87e56c0` and before it), `kind` a flag on each rather than a choice of which list to put it in.
- **A category is a reason to stop**—picking one promotes a point, clearing the last one demotes it—plus category search through Text Search and insert-between-points (`87e56c0`).
- **A leg that will not route says why** instead of blaming the road (`28b9c51`).
- **A rider chooses how dates and clocks read** (`19aea6c`), `src/views/date-format.ts`, three real locale tags rather than an abstract digit-order enum.
- **A build's version comes from the commit, and release notes have a page and a modal** ([#114](https://github.com/feralcreative/routeloop/pull/114)).
- **A day's clock is a wall clock at the departure point** (2026-08-24)—`public/js/day-clock.js`, and a data migration owed that is a script rather than a SQL file.

**Every roadmap item now has an issue, and so does every commit above.** Twenty-three were filed on 2026-08-24—[#115](https://github.com/feralcreative/routeloop/issues/115) through [#137](https://github.com/feralcreative/routeloop/issues/137). Fourteen were filed against work that had already shipped and closed the same minute, which is the point: **an audible gets its issue written after the fact and closed, so the history is on the tracker rather than only in this file.** The nine still open are roadmap items 21, 22, 23, 24, 25, 27, 29, 30, and 31, each now carrying a P-label, so the Priorities section can finally see them.

| Roadmap item | Issue | State |
| --- | --- | --- |
| 21. The import review table | [#129](https://github.com/feralcreative/routeloop/issues/129) | open |
| 22. Content width on `/prefs` and `/import` | [#130](https://github.com/feralcreative/routeloop/issues/130) | open |
| 23. Export by search and cart | [#131](https://github.com/feralcreative/routeloop/issues/131) | open |
| 24. Turn Turnstile on | [#132](https://github.com/feralcreative/routeloop/issues/132) | open |
| 25. Noob Mode | [#133](https://github.com/feralcreative/routeloop/issues/133) | open |
| 26. Rider feedback | [#115](https://github.com/feralcreative/routeloop/issues/115) | closed—shipped 2026-08-17 |
| 27. Compress stored originals | [#134](https://github.com/feralcreative/routeloop/issues/134) | open |
| 28. Route thumbnails | [#116](https://github.com/feralcreative/routeloop/issues/116) | closed—shipped 2026-08-22 |
| 29. Cards instead of rows | [#135](https://github.com/feralcreative/routeloop/issues/135) | open |
| 30. Make "Your records" flashier | [#136](https://github.com/feralcreative/routeloop/issues/136) | open |
| 31. Three columns on the dashboard tiles | [#137](https://github.com/feralcreative/routeloop/issues/137) | open |

The eight commits listed above are [#117](https://github.com/feralcreative/routeloop/issues/117) through [#128](https://github.com/feralcreative/routeloop/issues/128), all closed.

**Item 32 was recovered from a dead branch on 2026-08-24 and is [#139](https://github.com/feralcreative/routeloop/issues/139).** It had been written on 2026-08-16 onto `feat/rider-feedback`, which was never merged and was about to be deleted. Two other things came back off the same sweep: the answered open calls in `docs/rider-feedback.md`, which on `main` was still the pre-ship plan, and the whole thumbnails record in `docs/STATUS.md`, which [#110](https://github.com/feralcreative/routeloop/pull/110) was supposed to carry and lost in a merge. **The lesson is the one this section already makes: work that only exists on an unmerged branch is work nobody can find.**

### 2026-08-16: a planning day, and none of it has issues yet

**Read this before picking up work.** A long planning session changed the order of the whole roadmap and added six items. ~~**None of items 21 through 31 has a GitHub issue**, which matters because the Priorities section below says the P0–P3 labels are the authority on what to do next—so anything relying on labels alone will not see them.~~ **Resolved 2026-08-24**: all eleven were filed, and the mapping is in the 2026-08-24 section above.

**The order changed, and the new section outranks the tiers.** "The road to beta" sits directly above Priorities and is the phase order; the tiers now say which issue to pick up *within* a phase. Read both, in that order.

| What changed | Where |
| --- | --- |
| **New**: the road to beta—three phases, cohort rationale, and the note that nothing was deferred past the beta | "The road to beta", above Priorities |
| **Reversed**: rate limiting ([#16](https://github.com/feralcreative/routeloop/issues/16)) is **not** a beta blocker; map loads are already capped at 500/day | same section |
| **Widened**: item 20 is now three themes × light/dark on two independent axes, and the map deliberately does not invert | item 20 |
| **New**: the import review table—editable manifest, dedupe, alternates at import | item 21 |
| **New**: content width on `/prefs` and `/import`; a prerequisite for 21 and 23 | item 22 |
| **New**: export by search, cart and one zip, replacing the every-ride list | item 23 |
| **New**: turning Turnstile on, and the gate that would break ride creation | item 24 |
| **New**: Noob Mode | item 25 |
| **New**: rider feedback, which existed only in git-ignored `_PLANS/` | item 26 |
| **New**: gzip stored originals at rest, 7.2x measured; quota stays uncompressed and the default rises to 100 MB | item 27, folded into phase 2 |
| **New**: route thumbnails from Static Maps, built by a five-minute sweep that skips rides still being edited, gated by a URL hash | item 28, folded into phase 2 |
| **New**: ride lists become card grids on all four browsing surfaces, with the thumbnail as the card face | item 29, phase 2 and after 28 |
| **New**: visual treatment for the dashboard records block; quips were proposed and dropped the same day | item 30, unscheduled |
| **New**: yours/average/top columns on all four dashboard tiles, pooled over every rider and every ride | item 31, unscheduled |
| **Answered**: item 14's granularity question—day-level, decided by item 21 rather than here | item 14 |
| **Shipped**: item 14's alternate object, day-level and single-planner—voting and resolution still planned | item 14, and it unblocks item 21. [#68](https://github.com/feralcreative/routeloop/issues/68) **to be rewritten** to the remaining half, decided 2026-08-16 |

**Decisions that landed outside this file**, and will not be found by reading it alone:

- **`docs/main-menu.md`**—Settings is renamed **Preferences** at `/prefs`, with `/settings` and `/preferences` redirecting. Note the POST endpoint needs a 308 or an alias, not a 301.
- **`docs/api.md`**—four stale route rows corrected, including `routes/rides.ts` → `routes/builder.ts` in several places.
- **`docs/STATUS.md`**—the Maps key referrer list is now Google's two-entry recipe per domain, verified at runtime; a first round of testing produced a confident false pass and the reasoning is recorded so it is not repeated.
- **`_PLANS/turnstile-activation-260816T2144Z.md`**—the executable plan for item 24. **`_PLANS` is git-ignored**, so this exists on Ziad's machine only. The rider-feedback plan was promoted out of that directory to `docs/rider-feedback.md` the same day for exactly that reason; this one stays put as a single-sprint instruction rather than a specification.
- **`docs/myrouteapp-formats.md`**—new, and the research behind [#13](https://github.com/feralcreative/routeloop/issues/13) device-aware GPX.

<!-- col-widths: 22% 44% 34% -->

| Entry                            | What changed on 2026-08-10                                                              | Issue to match                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Vision → the model               | `Route` as level 2 became **Day**; **Leg** added as its own bullet                      | none—not tracked as an issue                                                                             |
| 2. The ride timeline             | "a route's duration" → "a day's duration"                                               | [#7](https://github.com/feralcreative/routeloop/issues/7) (closed)—title still reads "**Trip** timeline" |
| 5. One-tap Google Maps links     | batching described per route → **per day**, in three places                             | [#66](https://github.com/feralcreative/routeloop/issues/66) (closed)                                     |
| 9. Import and export breadth     | "colors" → "colors"                                                                    | [#13](https://github.com/feralcreative/routeloop/issues/13)                                              |
| 12. Quality and platform         | test count 424/20 files → **1,240/52** (869/37 when this row was written)               | [#16](https://github.com/feralcreative/routeloop/issues/16)—boxes ticked 2026-08-24                      |
| 13. Rider Subgroups              | "its own Route within the Ride" → **day**; "rides-hold-many-routes" → **-many-days**    | [#67](https://github.com/feralcreative/routeloop/issues/67)                                              |
| 14. Alternate routes and voting  | "day/route-level" → **day-level**                                                       | [#68](https://github.com/feralcreative/routeloop/issues/68)                                              |
| 15. On-the-road mobile interface | "a route's Google Maps legs" → "a day's"                                                | [#69](https://github.com/feralcreative/routeloop/issues/69)                                              |
| Backlog → elevation profile      | "per route" → **per day**                                                               | [#23](https://github.com/feralcreative/routeloop/issues/23)                                              |
| Backlog → reverse and duplicate  | marked **shipped**; it was still listed as unbuilt                                      | [#26](https://github.com/feralcreative/routeloop/issues/26) already closed—no action                     |
| 7. Bikes and range planning      | one-line stub replaced with a decided schema: bikes one-to-many off users, seven fields | [#11](https://github.com/feralcreative/routeloop/issues/11)                                              |
| Backlog → drag-to-reorder        | affordance decided: a textured drag bar, not arrows                                     | [#39](https://github.com/feralcreative/routeloop/issues/39)—**shipped 2026-08-15**, no action            |

Cleared on 2026-08-15: every entry that read "needs a new issue" now has one. Items 16, 17, 18, 19 and 20 became [#88](https://github.com/feralcreative/routeloop/issues/88) (an epic with eleven children, one of which is the pre-existing [#39](https://github.com/feralcreative/routeloop/issues/39)), [#99](https://github.com/feralcreative/routeloop/issues/99), [#100](https://github.com/feralcreative/routeloop/issues/100), [#101](https://github.com/feralcreative/routeloop/issues/101) and [#102](https://github.com/feralcreative/routeloop/issues/102). The dashboard got its first issue ever, [#103](https://github.com/feralcreative/routeloop/issues/103), and its own `area:dashboard` label.

Three issues carried the old vocabulary in their **titles**, which is a separate edit from their bodies. **Two of the three were fixed on 2026-08-24:**

- **[#49](https://github.com/feralcreative/routeloop/issues/49)**—now "Split a long route into days". It was the only one of the three where the stale word was also the feature's name.
- **[#23](https://github.com/feralcreative/routeloop/issues/23)**—now "Elevation and grade profile per day", matching the row above.
- **[#70](https://github.com/feralcreative/routeloop/issues/70) "Never drop tracks on import; land them all as routes"**—**left alone deliberately.** It is closed, and the title is the clearest surviving statement of the old model; retitling it would erase the only place that model is still legible.

## The road to beta

**Stated 2026-08-16, and it outranks the tiers below until the beta is running.** The P0–P3 labels say which _issue_ is next; this says which _phase_ the work is in. Where they disagree, this wins, and the disagreement is worth writing down rather than quietly resolving.

The goal is an MVP a handful of friends can actually test. **The cohort is the constraint:** it runs from web developers through hobby coders to, in Ziad's words, "total luddites who just like to ride." That range is the reason for the order.

1. **The builder panel and the mapping tools.** **Done as of 2026-08-22.** If a rider cannot plan or edit a ride, none of the rest is worth testing. Item 16 landed the panel; saved places ([#10](https://github.com/feralcreative/routeloop/issues/10)) and rich stop details ([#15](https://github.com/feralcreative/routeloop/issues/15)) were the rest of the scope confirmed on 2026-08-16, and both merged as [#111](https://github.com/feralcreative/routeloop/pull/111). A skeletal stop makes for a skeletal test ride, and thin test rides produce thin feedback. **What is owed is a browser pass on both**—nothing automated covers the builder. The remaining P1 issues are real builder work but none of them was ever part of this phase's bar.
2. **Import, export and send-to-device.** A tester handed a blank canvas forms no useful opinion. Handed their own familiar routes, the beta becomes an exercise in _using_ the app rather than _learning_ it—which is the only way to find out whether the end-to-end experience actually works. Items 9, 21, 22 and 23, and note that **[#13](https://github.com/feralcreative/routeloop/issues/13) device-aware GPX flavors is literally the "send to device" half** and is the one unshipped piece of item 9. `docs/myrouteapp-formats.md` is the research behind it. **Noob Mode (item 25) rides along here**, decided 2026-08-16: the least technical end of the cohort is exactly who it is for, and first contact is when it pays off—shipping it afterwards means the riders who needed it most already formed their impression without it.
3. **The feedback sprint, live before the first tester signs in. Done—shipped 2026-08-17**, out of phase order and ahead of phase 2. Decided 2026-08-16, and the ordering was a sequence rather than a permission to be late: a tester who hits a bug with no way to report it stops using the app and you never learn why, and the first session is when the most obvious problems surface. See item 26.

**So phase 2 is the only phase still open, and [#13](https://github.com/feralcreative/routeloop/issues/13) device-aware GPX is the next thing to pick up.**

**Rate limiting ([#16](https://github.com/feralcreative/routeloop/issues/16)) is _not_ a beta blocker. Reversed 2026-08-16, hours after being made one, because the argument for it was factually wrong.**

The case was "every anonymous view of a shared ride is a billable Maps load, so unbounded spend is a beta failure that is hard to walk back." **Spend is not unbounded**: `maps-backend/billable_default` has been capped at **500 map loads a day** since 2026-08-02, verified as an override rather than a default. The failure mode is therefore a map that stops drawing, not a bill—an availability problem, recoverable in a day, and nothing like the risk described. At the stated beta scale—a few friends, dozens of shares, scores at the very most—500 a day is generous.

**What the cap does surface is a real and different problem: it is now shared three ways.** The browser key gained `rollchart.app` in the 2026-08-16 referrer consolidation, dev traffic hits this same project by design (the caps were deliberately set above the free-tier break-even so a runaway does not also stop you working), and production shares the same 500. A busy day on rollchart plus a working day on localhost plus a handful of shared rides is a more plausible way to exhaust it than any number of beta testers—and during a beta, a dead map is worse than a small bill.

So the work that matters here is **visibility, not throttling**. **Decided 2026-08-16: add a quota-usage alert at roughly 80% of the 500/day map-load cap, and leave the cap and the shared key as they are.** One console setting, no code, and it produces real numbers on what a beta actually consumes—which is the input needed to decide later whether to raise the cap or split rollchart onto its own key. Raising the ceiling or separating the keys now would both be guesses made before any usage data exists.

#16 keeps its P1 label on its own long-standing argument for when sharing goes wide; it simply is not what stands between here and a few friends testing the app.

**Two things follow from the scope as confirmed.**

**Nothing was deferred past the beta, so this is a running order, not a filter.** Every phase above has to ship before testers arrive. Worth re-reading as the date approaches—if the beta needs to happen sooner than the list allows, something here moves, and it is better to choose which than to discover it.

~~**Rich stop details drags a schema fix in with it, and that fix reaches beyond the builder.**~~ **Settled 2026-08-21, and differently from what this paragraph predicted.** It argued that #15 forced ids into the payload and a server-side diff, rewriting `insertRideGraph`, `ridePayload` and `loadRidePayload`—and therefore reached into phase 2, since `insertRideGraph` is shared with the native JSON import. **None of that happened.** A client-minted `points.uid` keeps a point's identity across the delete-and-re-insert instead, `point_details` is keyed by `(ride_id, uid)`, and `insertRideGraph` barely changed. Row ids still churn, deliberately. Kept rather than deleted because the reasoning is a useful worked example: the constraint was real and the remedy this file assumed was not the cheapest one. See item 11.

## Priorities

Every open issue carries a **P0–P3** label. The labels are the authority on which issue to pick up within a phase; the item numbers below are stable identifiers, not an order. **Re-scoped 2026-08-15**—the tiers below mean something different than they did, so an issue's label is only as good as the last sweep. See "What changed, and why" underneath the table.

<!-- col-widths: 12% 88% -->

| Tier   | What it means                                                         |
| ------ | --------------------------------------------------------------------- |
| **P0** | Blocks real use of something that already ships. Do these next        |
| **P1** | The builder page, its tool panel, and the map engine                  |
| **P2** | The dashboard at `/`, plus real gaps riders will hit                  |
| **P3** | Everything else, including the group layer and the whole idea backlog |

### What changed, and why

P1 used to be _the group layer_. It is now _the builder_. The reasoning, recorded because a tier that changes meaning silently is worse than no tier at all:

**Planning a ride fluidly and intuitively is what this app is for.** Everything else in the product—sharing, hand-off, the group layer, the roadbook—is downstream of a plan that was pleasant to make. The map and the builder's tool panel are where that happens, and the panel has never been designed as one surface; it grew a control at a time. Item 16 measures the damage: 198 interactive elements in a 380px column, 807px of content in a 620px window, and a layout that jumps on nearly every edit.

**The group layer went to P3, not P2.** Nobody is in the beta and nobody will be for a while, so nothing needs #71, #72 or #73 to work. The dependency chain those three describe is still correct and still in item 8—it just is not next. #12 sits on top of all three and went with them.

**#16 stays at P1** despite being platform work, for the one reason it was already there: rate limiting. Every anonymous view of a shared ride is a billable Maps load, so cost scales with strangers rather than with accounts. That has to exist before rides are shared widely, and it is indifferent to what the rest of the tiers mean.

**The dashboard is P2 and had no issues at all.** `/` carries the stats, and until 2026-08-15 the nav did not link to it—the only way in was the logo. That gap is closed; nothing else about the page has been specified.

**P0 is empty as of 2026-08-06.** The tier that used to hold this section has been cleared:

- ~~**[#8](https://github.com/feralcreative/routeloop/issues/8) Route shaping.**~~ **Shipped 2026-08-06.** A rider can pull a route onto the road they meant; everything else in the planner had been assuming the line was right with no way to correct it.
- ~~**[#38](https://github.com/feralcreative/routeloop/issues/38) Autosave and undo.**~~ **Shipped 2026-08-05.** The competitive research filed undo as a defection trigger rather than a nicety: "works pretty good at route planning until I mess up, then can't undo the mistake and have to start a new trip."
- **[#69](https://github.com/feralcreative/routeloop/issues/69) On-the-road mobile interface** is now labeled **P2**, not P0. The navigate page exists and is not yet usable in gloves at a fuel stop: no finished-leg marking, no progress memory, no tolerance for losing signal. That is still the difference between a demo and the feature, but the label is the authority and the label says P2.

**With P0 clear, P1 is the work.**

**P1—the builder. Item 16 was first within it and is now done**, shipped 2026-08-15 on `feat/builder-panel` and awaiting review; the panel's eleven decided changes all landed in one day, in five phases. Re-measured on the ride the numbers above came from, its content is **618px in a 617px window** where it was 807 in 620, and the seven-stop day no longer scrolls. Nothing about the tier changed—the reasoning that moved P1 here still holds, and the rest of the list below is what it now means.

The rest of P1 is the issues that touch `public/js/builder.js` and the map engine. Drag-to-reorder ([#39](https://github.com/feralcreative/routeloop/issues/39)) came off this list with item 16, which adopted it. Saved places ([#10](https://github.com/feralcreative/routeloop/issues/10)) and rich stop details ([#15](https://github.com/feralcreative/routeloop/issues/15)) came off it on 2026-08-22, closed by [#111](https://github.com/feralcreative/routeloop/pull/111). What is left: keyboard shortcuts ([#40](https://github.com/feralcreative/routeloop/issues/40)), splitting a long day ([#49](https://github.com/feralcreative/routeloop/issues/49)), lodging as a day boundary ([#54](https://github.com/feralcreative/routeloop/issues/54)), detour-radius discovery ([#50](https://github.com/feralcreative/routeloop/issues/50)) and layer stacking ([#51](https://github.com/feralcreative/routeloop/issues/51)).

**The ID-churn warning that used to sit here is spent.** Autosave made `PUT /api/rides/:id` run constantly, and it still deletes and re-inserts every day and point, so row ids still change on every save. #15 was the first feature that needed a point to survive one, and it shipped with a client-minted `points.uid` for exactly that. **Anything else on this list that needs to reference a point across a save now has an answer**—use the uid, not the id—so this is no longer a thing to solve before starting.

**They are no longer blocked on the panel being worth adding to**, which was the argument for doing item 16 ahead of all seven.

**[#16](https://github.com/feralcreative/routeloop/issues/16) stays P1 on its own argument**—rate limiting, per the note above. It is the one P1 that is not builder work.

**The group layer moved to P3**, in the dependency order it always had: [#71](https://github.com/feralcreative/routeloop/issues/71) ride membership, then [#72](https://github.com/feralcreative/routeloop/issues/72) friendships, then [#73](https://github.com/feralcreative/routeloop/issues/73) the visibility levels that need both, with [#12](https://github.com/feralcreative/routeloop/issues/12) on top of all three. That chain is unchanged and still correct; only its position moved. P1 used to say this was "where the product stops being single-player, and the reason a rider brings anyone else"—still true, and it waits, because a rider brought to a planner that is awkward to plan in does not stay.

## Vision

MyRouteApp, but far better: entire-ride focused, with a slicker UI and smoother UX.

Routeloop is a tool to **plan, organize, and share** motorcycle rides and car road trips—not real-time navigation, and never will be. The point is to give riders a holistic view of an **entire** ride: every leg, every day, every stop, every hotel and gas station, across an unlimited number of days and miles. Existing tools cap out (Google My Maps allows ~10 waypoints and one route per layer; Apple Maps behaves differently on every device) and none of them shows the whole ride at once. Routeloop has no such limits.

The model that everything else follows:

- A **Ride** is the shareable package—many days, with a start and an end that bound the whole ride.
- A **Day** is one session inside a ride: an ordered list of stops joined by road-snapped legs, with its own color, title and start/end date-time. A day is a _position_ in a ride, not a calendar date—two days can share a date, and a ride with no dates at all still has days.
- A **Leg** is the road-snapped geometry from one stop to the next. It is never user-visible; the table is `route_legs`, which keeps that name on purpose because a leg really is a routed segment.
- Three kinds of dots:
  - **Waypoint**—an ephemeral shaping point that only keeps the route on course. Nothing remarkable about the spot; we do not stop there.
  - **POI**—something interesting near the route (a vista, a museum, a quirky store) we might or might not stop for. It never affects routing.
  - **Stop**—a real stop (gas, food, rest, hotel). Stops always have a duration; "ends" are stops with no duration.
- **No platforms, no limits.** Import and export as many open route formats as possible, and never depend on a proprietary, licensed one.

The signature interaction is the **timeline**: a slider across the bottom of every ride and day, from its start time to its end time. The whole ride stays visible while the slider focuses the leg or section that corresponds to a given date and time.

Where this document still says "route" it means the drawn path—the line on the map, the thing you shape and export. It no longer means level 2; that is a **day**.

<!--| PAGE-BREAK -->

## Where things stand

Built and deployed today (see STATUS.md for the living detail):

- **Data model**—rides → days → stops/POIs → routed legs, plus the 17-role stop taxonomy.
- **Import**—KML/GPX upload becomes a structured, editable ride, through an XXE-safe, quota-enforced pipeline.
- **Ride builder**—plan a road-snapped route, classify stops, save. Now **multi-day**: every day of a ride is drawn on one map, with a day-focus slider.
- **Native viewer**—shared rides render from the database.
- **User profiles & authorization**—`users.status` gates who may use the app; profile page; home-address seeding.
- **Auth**—Google OAuth + emailed magic link, replacing Cloudflare Access.
- **Maps**—rendering, search (Places New) and routing (Routes API) all on Google.
- **Admin panel**—the owner approves, blocks and reinstates rider accounts.
- **Twistiness**—each day carries a measure of how much its roads bend, derived from geometry so imported rides get one too. Shown as a word in the builder and the viewer legend.
- **Expand**—a hand-off-time transform that weaves shaping points along the planned geometry, so whatever you navigate with has too little room to pick its own roads.
- **The navigate page**—`/m/:slug/navigate` turns a ride into an ordered series of Google Maps links, one leg at a time, with a density control and an honest statement of the longest stretch Maps still chooses for itself.
- **Lossless import**—a file holding several tracks lands as several days, names and all, rather than as its longest track.
- **Import and export**—six formats in (KML, KMZ, GPX, GeoJSON, CSV, native Routeloop JSON), five out, several files at once becoming the days of one ride, and every original kept so nothing an upload contained is destroyed.
- **Roadbook**—a printable stop-by-stop sheet: leg and cumulative miles, miles since fuel, planned dwell, and an estimated clock.
- **Route shaping**—drag the route line onto the road you meant; the dropped point becomes an ephemeral via-point on the right leg and only that leg re-routes.
- **Undo and drafts**—undo/redo in the builder, plus a draft that survives a crash, a closed tab or a dead phone, including for a ride that has never been saved.
- **Autosave**—the builder has no Save button. A 3s idle debounce and a 20s ceiling, with the crash draft still underneath for the cases a server flush cannot cover.
- **The builder panel, designed as one surface**—item 16 entire: the ride's name as the heading, an exit off the map, a drag handle and one menu per row, fixed footprints for everything that used to grow, the timeline moved out onto the map's bottom edge, and stop durations in whichever format the rider picks.
- **Basemaps**—the map opens on Google's terrain layer, with roadmap, satellite and hybrid behind a switcher that remembers the choice per rider.
- **Rich stop details**—a stop carries a confirmation number, check-in and check-out, phone, address, links and notes, kept in their own table and visible to the owner alone. They ride along in the native JSON and are stripped from every lossy export.
- **Saved places**—a rider's reusable library of locations, optionally filed into groups, offered inside the builder's search field and copied into a ride rather than referenced from it.
- **CI**—typecheck and the full test suite on every pull request and push to `main`, against Node 22 and 24. (1,728 tests across 67 files as of 2026-08-26; `npm test` is the authority, not this number.) Note SCSS is **not** built in CI, which is why item 12's checklist calls that box partial.
- **Alternates**—two or more days grouped as candidates for the same stretch, exactly one active, and only the active one counted by anything that sums a ride.
- **Rider feedback**—reports, ideas and questions from a signed-in rider, a public board at `/board` and the owner's queue at `/admin/feedback`. A report is private to its author and the owner until it is published, and nothing publishes one by default.
- **Route thumbnails**—a preview image per ride from Static Maps, built by a sweep that skips rides still being edited.
- **A POI is part of the route**—a day is one ordered list of points and `kind` says only whether the rider means to stop, so `legs[i]` joins `points[i]` to `points[i+1]` whatever kind either end is. A category is what promotes a point.
- **Date and clock preference**—a rider picks the digit order and the clock follows, because the stored values are real locale tags rather than an abstract enum.
- **A day's clock is a wall clock at the departure point**—9am means 9am where the bike is, on the builder, the timeline and the printed roadbook alike, for every viewer.
- **Build version and release notes**—the version is the minute of HEAD's committer date in Pacific, so redeploying the same tree reports the same version; release notes have a page and a modal.

**Everything from 2026-08-17 onward in that list is built and NOT deployed.** The heading above says "deployed" and has meant "built" since then—see STATUS.md, which also carries the migrations that have reached no environment.

The two big migrations (auth and maps) are **done**, in the code and in the Google Cloud console. One thing remains: removing the redundant Cloudflare Access policy at the edge, which is gated on a verified prod deploy and tracked in #58.

## Roadmap

### 1. Finish the Google migration and clear debt

**Goal.** Retire the last Mapbox dependency and the redundant Cloudflare Access policy so the stack is single-vendor and the dead config is gone.

**Work.**

- [ ] Remove the Cloudflare Access policy at the edge (the app already ignores its header; the policy is now pure redundancy).
- [x] Move `profile.js` home-address geocoding to a server proxy alongside `POST /api/route`—the last Mapbox call and the only reason `MAPBOX_TOKEN` still has to be set.
- [x] Teach the current engine to draw an imported ride's single-leg track, then collapse the two viewer shells into one and delete `public/js/main.js`. (The engine already handled it; the work was deleting the legacy shell.)
- [x] Drop `MAPBOX_TOKEN`, `MAPBOX_GL_VERSION` and `MAPBOX_CSS_LINK`, plus their `.env.example`, compose and deploy-guard references.
- [x] Regenerate the favicons and social image from the current Routeloop mark. Done 2026-07-31; the files live in `public/img/favicon/`.
- [x] Add privacy-policy and terms pages (required to publish the OAuth consent screen past 100 users).
- [x] Set per-API daily quota caps on the GCP project so a runaway loop can't run up a bill. Done 2026-08-02—five metrics capped; see STATUS.
- [x] Disable the Maps APIs the app does not use. Done 2026-08-02—23 of 27 off, leaving only Maps JavaScript, Places (New), Routes and Geocoding. **Maps Static was switched back on 2026-08-21** for the ride thumbnails; see item 28.

**Touches.** `public/js/profile.js`, `src/routes/routing.ts`, `src/routes/*` viewer shells, `src/index.tsx`, `src/config.ts`, `src/views/layout.ts`, `public/img/`.

**Status.** Done, bar one thing. Mapbox is retired, the two viewer shells are one, the legal pages shipped, the favicons were regenerated on 2026-07-31, and the GCP console work landed 2026-08-02 (quota caps applied, 23 unused Maps APIs disabled). The tracking issue #6 is closed; the single remaining item—removing the Cloudflare Access policy at the edge—moved to #58, because it is gated on a verified prod deploy and nothing in this repo will ever tick it.

### 2. The ride timeline

**Goal.** Ship the signature feature from the vision: a date-time slider that focuses a ride in time.

**Work.**

- [x] A date-time UI in the builder that writes `days.start_at` / `days.end_at` (the columns exist and already load into builder state; nothing sets them yet).
- [x] A timeline slider across the viewer and builder that maps a moment to the leg/section active then, dimming the rest without hiding anything.
- [x] Sensible defaults: derive a day's duration from its legs, and seed each day's start from the previous day's end.

**Touches.** `public/js/builder.js`, `public/js/viewer.js`, `public/js/map-common.js`, `src/db/schema.ts` (already has the fields), `src/routes/builder.ts` (renamed from `rides.ts`), `src/views/layout.tsx` (`rideTimeline()`, which both map shells render), `src/index.tsx`.

**Status.** done on `feat/trip-timeline-slider`, closing #7 and #19. Duration is derived as legs **plus** stop dwell, and deliberately kept separate from `days.duration_s`, which caches riding time only. `ride.json` now carries per-leg spans—the viewer could not map a moment to a leg without them. The time model is shared by both clients in `public/js/ride-time.js` so they cannot disagree. See docs/STATUS.md for the rest, including the two properties of leg spans that real data will break a naive assumption about.

**Moved 2026-08-15, under item 16.** The slider was inside the builder's tool panel and the viewer's; it is now a bar across the bottom edge of the map on both, which is where this section's own Vision line has always put it—"a slider across the bottom of every ride and day". Only its home changed: the time model, the ids and both clients' handling are the same. It also **hides rather than going inert** on a ride with no dates now, which is the opposite of what it did in the panel and right for the opposite reason—there is nothing underneath it on the map for a disappearing control to reflow.

### 3. Route shaping and server-side export

**Goal.** Let riders pull a route into the exact shape they want by dragging the line onto the roads they mean, and export a finished ride to open formats.

**Work.**

- [x] **Drag the route line onto a different road to shape it.** Grabbing a rendered leg anywhere and dragging it to a nearby road drops a **waypoint**—an ephemeral leg via-point—at the release point and re-snaps the leg through it, so the route follows the road you meant rather than the one the router picked. This is the standard rubber-band map drag, and it is the third dot kind from the vision.
- [x] Persist the pulled points into `route_legs.via_points`. On drop, re-request only the affected leg through `POST /api/route` with the new via list; the anchor stops stay fixed.
- [x] Via-points are themselves draggable and removable after creation, and render distinctly from stops and POIs—smaller and clearly ephemeral—so the routing anchors stay legible.
- [x] Moving or reordering a stop invalidates that leg's shaping and clears its via-points, so a stale shaping point can't fight a new route.
- [x] `src/maps/export.ts`—generate KML, GPX, GeoJSON and CSV from stored rows, and make downloads source-aware: an imported ride streams its stored original (byte-for-byte, which is why the file is kept) and everything else is generated. A native ride can be downloaded as any of the four for the first time.
- [x] Round-trip the `ROLE - Name` convention on export so files reopen correctly in Google Earth and elsewhere.

**Touches.** `public/js/builder.js`, `public/js/route-shape.js`, `public/js/map-common.js`, `src/maps/export.ts`, `src/routes/maps.ts`, `src/maps/roles.ts`.

**Status.** shipped—export in sprint 09 (2026-08-03), drag-to-shape on 2026-08-06 ([#8](https://github.com/feralcreative/routeloop/issues/8)). The index arithmetic that turns a drag on the day's single concatenated polyline back into "leg 3, between via 1 and via 2" lives in `route-shape.js`, kept pure so `test/route-shape.test.ts` can drive it.

<!--| PAGE-BREAK -->

### 4. Expand: densify a route so a hand-off stays on your roads

**Goal.** Give a nav app only your stops and it picks its own roads between them—often not the ones you meant. **Expand** fixes that: it densifies the route with extra shaping waypoints sampled along the planned geometry, pinning whatever you hand it to onto your roads. This is MyRouteApp's "Expand," the owner's favorite feature there—a 10–20-point route expanded to 30+ points to stay on track. It is provider-agnostic and improves _every_ hand-off: the Google Maps links (item 5) and the Garmin/TomTom file exports (item 3) alike.

**Work.**

- [ ] Densify a route by sampling extra shaping waypoints along the stored leg geometry (`route_legs.geometry` already holds the full, 6-decimal, road-snapped polyline), so a hand-off follows the planned roads instead of the nav app's own guess between distant stops.
- [ ] Rider-controllable density—a target point count or spacing. The owner's habit: expand a 10–20-point route to at least 30.
- [ ] Expansion is a hand-off-time transform over geometry that already exists, not new stored route state—Routeloop's own viewer renders the exact path already, so Expand matters only when leaving the app.
- [ ] Refinement: bias added points toward junctions and decision points, where a nav app is most likely to diverge, rather than purely even spacing.
- [ ] Expand-added points are shaping points, not stops: written as Garmin/TomTom _shaping_ points in the file exports (item 3) and counted as plain waypoints in the Google Maps links (item 5).

**Touches.** new `src/maps/expand.ts` (densify over leg geometry), `route_legs.geometry` as the source, the export path (item 3) and the Google Maps link builder (item 5).

**Status.** done on `feat/expand-route`. `src/maps/expand.ts` places shaping points to bound the longest unpinned stretch rather than spacing them evenly—even spacing wastes points on a straight where the nav app was never going to diverge. Density is the rider's call at hand-off time (off / light / tight), because every extra point is another link and another tap. Nothing is stored: it is a transform over `route_legs.geometry`, which is what makes it free to change later.

### 5. One-tap Google Maps links

**Goal.** Hand a rider the exact route they planned, ready to navigate in Google Maps, instead of a loose set of stops it re-routes between however it likes. Google Maps takes 9 waypoints plus an origin and a destination per URL, so a route—especially an Expanded one—is serialized into an ordered series of links. This is the direct answer to the vision's first pain point, that Google My Maps caps at ~10 waypoints.

**Work.**

- [ ] Serialize a day's ordered points (after Expand, item 4) into Google Maps directions URLs—the `https://www.google.com/maps/dir/?api=1&…` form, or the `/maps/dir/lat,lng/lat,lng/…` path form.
- [ ] **Every point is a plain Google Maps waypoint.** Waypoint, POI, stop and Expand-added points all collapse to the same thing here: Google Maps does not differentiate the kinds and cannot attach a duration to a stop, so all of them count equally toward the batches. The kind and duration distinction only matters for the file exports (items 3 and 9), where GPX and KML can carry it.
- [ ] **Batch at no more than 10 points per URL.** Expand multiplies the point count, so it multiplies the links: a 30-point route is at least three of them; a 28-point route without expansion is 10, then 10, then 8.
- [ ] **Never batch across a day boundary.** Batching resets at the end of each day, so a day's final link is short rather than topped up with the opening points of the next day. Each day is chunked independently.
- [ ] A share surface that lists the links per day and batch—e.g. "Day 2 · part 1 of 3"—copyable and sendable to riders.

**Open questions to settle when building.**

- **Batch continuity.** A clean partition (10 + 10 + 8) leaves a gap between links: the segment from point 10 to point 11 sits in no URL. Overlapping each batch by one point (…9, 10 │ 10, 11…) closes the gap at the cost of one point per link. Decide which, and make the choice obvious in the UI.
- **Coordinate order.** Google Maps URLs want `lat,lng`; the app stores `[lng, lat]`. Reuse the existing conversion discipline (`toLatLng` / `fromLatLng`), never a fresh inline swap.

**Touches.** new `src/maps/gmaps-links.ts` (link builder), `route_legs.geometry` and Expand (item 4) as the source, `public/js/viewer.js` and the share UI, possibly a small share endpoint under `src/routes/`.

**Status.** done on `feat/expand-route`, in `src/maps/gmaps-links.ts`. Three things were settled by testing on a real iPhone rather than from the documentation:

- A `/maps/dir/?api=1` link opens the **native app** and carries **9 waypoints**, so 11 points per link counting the two ends. Google's docs say "up to three waypoints supported on mobile browsers, and a maximum of nine waypoints supported otherwise"—the three applies to a route rendered in the mobile browser, not to the app the link hands off to. Earlier drafts of this roadmap said ~10 points; that figure was an assumption.
- Omitting `origin` makes Maps start from the rider's current location and offer **Start** instead of **Preview**, which removes the "add Your Location and drag it to the top" ritual at every fuel stop.
- Raw coordinates render as "dropped pin". Named places need Google place IDs, which this app does not store; the route is exact and navigable either way.

Consecutive links overlap by one point, so the leg between two batches is never left unnavigated, and a batch prefers to end on a stop—a tap is free if the rider is already off the bike.

### 6. Saved places

**Goal.** A rider's reusable library of locations (home, favorite fuel stops, meet points) they can drop into any ride.

**Work.**

- [x] Schema for places and place groups—`places` and `place_groups`, migration `drizzle/0007_glossy_charles_xavier.sql`.
- [x] CRUD endpoints at `/api/places` and `/api/place-groups`. **No marker-group primitive was built**, and it turned out not to be needed: saved places surface through the builder's existing search field rather than as a layer on the map, so there is nothing extra to draw. Revisit only if a "show all my places" view is actually wanted.
- [x] Builder integration—saved places appear IN the add-row search list, above the Google predictions, matched locally from one character with no network call and no billing. "Save to my places" on any stop's row menu is the creation path.

**Where places are created, and why not on the profile.** A place needs a pin, and the builder is where the map is. The profile screen manages what is already there—rename, refile, delete, and the groups themselves. A create-from-scratch flow there wants the address picker from item 19 rather than a pair of lat/lng boxes, and should wait for it.

**Touches.** `src/db/schema.ts`, new `src/places/policy.ts` and `src/places/service.ts` (rule-from-query split), new `src/routes/places.ts`, new `public/js/places.js`, `public/js/builder.js`, `src/routes/profile.tsx`, `style/_builder.scss`, `style/_forms.scss`.

**Status.** **shipped 2026-08-22** on `feat/saved-places`, merged as [#111](https://github.com/feralcreative/routeloop/pull/111) and closing [#10](https://github.com/feralcreative/routeloop/issues/10). `test/places.test.ts`. Stacked on `feat/rich-stop-details` rather than branched from `main`, because a place pre-fills a stop's details and those only exist there.

**Three decisions, all Ziad's, 2026-08-21.** **Copy, not reference**—see the note in AGENTS.md and `placeToStop()`. **Groups from the start**, but a group is optional: requiring one would mean inventing a folder before saving a first place, so `group_id` is nullable and "Not in a group" is a real section. **Places carry phone, address and links**—the half of rich stop details that is a fact about the place rather than about one trip.

### 7. Bikes and range planning

**Goal.** Model bikes and riders so the app can reason about range and comfort, per the original vision.

**The model**, decided 2026-08-10: a bike belongs to exactly one rider and a rider owns many bikes—a plain one-to-many hanging off the user, not a shared catalog. A bike never owns a rider. Fields: **make, model, year, mpg, tank size, range to light, range to empty.**

**Work.**

- [ ] A `bikes` table owned by `users`, with the seven fields above, plus CRUD on the profile page beside the avatar (item 17).
- [ ] Per-rider comfort limits—these belong to the rider, not the bike, and stay on the profile.
- [ ] Fuel/charge range rings and low-range warnings between stops.
- [ ] Suggest rest cadence from rider limits and leg durations.
- [ ] EV counterpart—battery and consumption in place of tank and mpg. Tracked separately as [#31](https://github.com/feralcreative/routeloop/issues/31); the schema should not make it awkward.

**Open questions.**

- **Stored or derived.** `mpg × tank size` already implies a range, so _range to light_ and _range to empty_ are arithmetic on paper. They are not in practice: riders know their real numbers and those numbers beat the spec sheet. Recommendation is to store all three as entered and never overwrite a rider's figure with a computed one—but whether the fields seed themselves from the math on first entry is undecided.
- **Units.** mpg assumes US units. Ties to the miles/km preference still open in `docs/main-menu.md`, and the stored unit should be settled before the column exists rather than after.

**Touches.** `src/db/schema.ts`, new routes, `src/routes/profile.ts`, `public/js/builder.js`.

**Status.** **shipped 2026-08-26.** The `bikes` table, the paddock CRUD on the profile page and the photo upload landed as [#151](https://github.com/feralcreative/routeloop/pull/151); [#52 "Group-aware range planning"](https://github.com/feralcreative/routeloop/issues/52) closed on 2026-08-26 once items 8 and 13 landed with it, and fuel is now planned around the smallest tank coming with whose it is named. Range is stored in METERS and typed in MILES—`src/bikes/policy.ts` is the only place the two meet, because #150 will switch the site to metric. Still open from this item: range rings on the map, rest cadence from rider limits, and the EV counterpart ([#31](https://github.com/feralcreative/routeloop/issues/31)).

### 8. Riders and group rides

**Goal.** Turn a solo planning tool into a group one.

**Work.**

- [x] Rider list / roster—`/m/:slug/riders`, gated on membership rather than visibility.
- [x] Invite riders to a ride; per-ride RSVP.
- [ ] Surface cost splitting from the payment handles already stored on the profile. **The one box left.**
- [x] Rate-limit rider lookup by email/phone before it exists—**answered by not having the surface.** You can only add a FRIEND to a ride: no token, no email, no link, so there is nothing to enumerate.

**Touches.** `src/db/schema.ts`, `src/members/`, `src/friends/`, `src/routes/roster.tsx`, `src/routes/friends.tsx`.

**Status.** **shipped 2026-08-26** as [#152](https://github.com/feralcreative/routeloop/pull/152) (friendships and the access layer) and [#153](https://github.com/feralcreative/routeloop/pull/153) (membership and voting). `ride_invites` was scoped and then **replaced rather than deferred**—friendships dissolved the sign-off it needed, since a friend already has an active account and has already passed approval. See `docs/decisions.md`.

### 9. Import and export breadth

**Goal.** Handle as many open route/map formats as possible, in both directions.

**Work.**

- [x] **Native Routeloop JSON export/import**—`/routeloop.json` writes the builder's own save payload and the importer feeds it back through the same schema and the same insert. Verified lossless on a real 3-day ride: days, colors, start/end times, legs, via points, stops, POIs, dwell and roles all identical. The `routeloop` version field is what tells it apart from a GeoJSON, since both arrive as `.json`.
- [x] Import KMZ (zipped KML)—the archive is read by `src/maps/kmz.ts` and its KML handed to the existing pipeline, so the cap is on the _decompressed_ size.
- [x] Import/export CSV—a stop list, not a route. `src/maps/csv.ts` parses RFC 4180 (a quoted comma in "Chevron, Petaluma" is not an edge case), sniffs the delimiter, and reads a decimal comma. No geometry, so no mileage and a **null** twistiness rather than a zero.
- [x] Import/export GeoJSON—`src/maps/geojson.ts` in, `src/maps/export.ts` out. The only format that keeps roles, the stop/POI distinction and dwell time across a round trip, because it is the only one whose properties this app controls.
- [x] Export GPX that loads cleanly on a device—stops are `<wpt>` and shaping points are `<trkpt>`, never `<rte>`/`<rtept>`. A route file lets the device re-derive the ride between anchors, which is the failure the FAQ describes under "Why does my GPS ignore the route I planned?".
- [x] Keep every added format inside the existing XXE-safe, quota-enforced import pipeline.
- [x] Round-trip fidelity tests per format (#35)—`test/fixtures/` holds one ride written five ways and `test/round-trip.test.ts` asserts the parsers agree. It caught a real disagreement on its first run: KML read a one-point line as a zero-length track while GeoJSON rejected the whole file.

**Touches.** `src/maps/kml.ts`, `src/maps/export.ts`, `src/routes/maps.ts`, `src/routes/builder.ts` (the payload shape—renamed from `rides.ts` in [#104](https://github.com/feralcreative/routeloop/pull/104)).

**Status.** in progress—KMZ, GeoJSON, CSV and multi-file import landed 2026-08-03. Several files become several days of one ride, which is what a rider with a folder of per-day GPX files actually has.

The single-file gap closed 2026-08-04 (#70): every track in a file now lands as its own day, in document order, carrying the file's own name for it—GPX `<trk><name>`, KML Placemark names, GeoJSON feature names. All three parsers previously kept only their longest line and discarded the rest, which meant the app could not read back its own multi-day export. Waypoints are assigned to the day they physically sit on, since GPX ties them to nothing. More than 31 days is refused rather than truncated.

Remaining: device-aware GPX flavors (#13)—`buildGpx` writes GPX 1.1 with `<trk>` and no device picker, and a Garmin wants `<rte>` shaping points. Note that a picker is interface, and this item has never held any: **the `/import` page itself is now item 21**, and #13's control should be drawn as part of that page rather than bolted onto it afterwards. See also `docs/myrouteapp-formats.md`, which works out what a MyRoute-app file can and cannot carry in either direction.

### 10. Discovery and public profiles

**Goal.** Make good public rides findable and give riders a public identity.

**Work.**

- [x] Public profile pages at `/@username` (usernames are already reserved and unique).
- [x] A browsable gallery of public rides, sorted by recency and popularity (`rides.view_count` exists).
- [x] "Clone this ride" so a public ride can seed a new plan.

**Touches.** `src/routes/*`, `src/views/layout.ts`, `src/db/schema.ts`.

**Status.** done on `feat/legal-and-faq-pages`, closing #14 and #26. What a public surface may show is stated once in `pages.ts` rather than decided per template: username, display name and public rides are shown; last name is opt-in; first name, email, address, coordinates and payment handles never. Clone drops descriptions and times and lands private. See docs/STATUS.md for the Hono routing gotcha that makes `/@username` work.

### 11. Rich stop details

**Goal.** Let a stop hold everything a rider actually needs when they arrive—reservations, confirmation numbers, gate and door codes, check-in / check-out times, links, and freeform notes—not just a name and a category.

**Work.**

- [x] Structured detail fields on a stop: confirmation number, check-in and check-out date-time, phone, address, and up to five labelled URLs. In `point_details`, migration `drizzle/0006_wild_hammerhead.sql`.
- [x] A freeform notes field.
- [x] Surfaced **by role**—`detailFieldsFor()` in `public/js/builder.js`. Lodging gets check-in/out; a table role gets a reservation time; everything else gets phone, address, notes and links. **A stop with NO roles gets the full set**, not the minimum: an uncategorized stop is one the rider has not labelled yet, and hiding fields from it looks like a bug.
- [x] Builder UI behind a row-menu item, with a badge on rows that carry details; viewer UI as a ruled-off block in the popup headed "Only you can see this".
- [x] **Privacy boundary—this is the load-bearing part.** Gate codes, confirmation numbers and phone numbers are private. They must not go out with a public or unlisted share (they'd otherwise leak through `ride.json`), and probably not in exports either—only the owner sees them, and later, invited riders. Model this the way `user_profiles` is split from `users`: sensitive detail kept off any payload that reaches a public viewer's client. Note that `points.description` already exists (2000 chars) and `sanitizeText` / `esc` already defuse `javascript:` and `data:` URLs—reuse both.

**Touches.** `src/db/schema.ts`, `src/maps/uid.ts` and `src/maps/point-details.ts` (both new), `src/maps/ride-graph.ts`, `src/maps/export.ts`, `src/routes/builder.ts`, `src/routes/maps.ts`, `src/index.tsx`, `src/account/export.ts`, `public/js/builder.js`, `public/js/builder-history.js`, `public/js/map-common.js`.

**Status.** **shipped 2026-08-21** on `feat/rich-stop-details`, merged as [#111](https://github.com/feralcreative/routeloop/pull/111) and closing [#15](https://github.com/feralcreative/routeloop/issues/15). `test/point-details.test.ts`, plus additions to `test/builder-history.test.ts`.

**The ID-churn prerequisite was solved differently from the plan, and that is the decision worth recording.** The governing text above and in item 16 assumed "send ids in the payload and diff server-side", which rewrites `insertRideGraph`, `ridePayload` and `loadRidePayload`—the path the native JSON import shares. **Ziad's call 2026-08-21: a client-minted `points.uid` instead.** The delete-and-re-insert model accepted on 2026-08-15 is untouched; `point_details` is keyed by `(ride_id, uid)` rather than by the row id that churns, and identity rides along in native JSON exports for free. `insertRideGraph` barely changed. **Row ids still churn**, so anything else that needs a point to keep its identity—a comment, a photo—uses the uid too and does not need this revisited.

**Exports: native JSON only, decided 2026-08-21.** Details are in the lossless native JSON, because that is the rider's own backup and re-import path, and stripped from GPX, KML, GeoJSON and CSV—those get handed to devices and forwarded to riding buddies, and none of them can express "this field is private". `loadNativeRide` takes the details map as an argument rather than fetching it, so forgetting to pass it fails CLOSED: the export is merely incomplete rather than a leak.

**Verified against a real public ride, not reasoned about.** A canary detail row was planted on a public ride and all seven anonymous surfaces (`ride.json`, both native names, and the four lossy formats) were fetched and checked; every one returned 200 and none carried it. A second signed-in rider who is not the owner also saw nothing. The owner sees them in the builder, in `ride.json` and in the popup.

### 12. Quality and platform

**Goal.** The groundwork that keeps a growing, multi-contributor codebase honest.

**Work.**

- [ ] An automated test suite. Vitest is configured and `roles.ts`, the format parsers, Expand, the Google Maps link builder, the drag-to-shape index math and the builder's undo/draft model are covered (1,728 tests across 67 files as of 2026-08-26). Still missing: the leg-distance clamp, integration tests for ride save/load, and a viewer smoke test.
- [x] CI on GitHub Actions: `npm run typecheck` and `npm test` on every pull request and on pushes to `main`, against Node 22 and 24 (`.github/workflows/ci.yml`). The SCSS build is deliberately not gated—formatting and style are qlty's job, and a failing build there would block a PR on something no reviewer reads.
- [ ] Error tracking / structured request logging in production.
- [ ] Rate limiting on public and auth endpoints.
- [ ] An accessibility pass (keyboard, focus, contrast, ARIA) and groundwork for i18n.
- [ ] Installable PWA with an offline view of a saved ride.

**Touches.** repo-wide; new `test/`, `.github/workflows/`.

**Status.** planned—pick these up alongside feature work, not in a big bang.

### 13. Rider Subgroups: converging and splitting group rides

**Goal.** Model a group ride the way it actually happens: riders, organized into **Rider Subgroups**, set off from different places, converge at one or more meeting points, ride the middle as one group, then split back into subgroups at the end to head home in different directions. A Rider Subgroup is a named set of riders sharing an approach—the Oakland contingent, the Sacramento contingent—and it is the primitive the whole feature is built on. Each person gets one continuous plan of their own—their origin, the pickups along the way, the shared middle, their route home—while the planner sees the whole converging-and-diverging shape on one map. The worked example: a Sierras ride where people leave from Santa Cruz, San Jose, San Francisco, Oakland and Sacramento, join at meeting points along the way, ride the rest as one pack, and reverse the process going home.

**Work.**

- [x] Make **Rider Subgroup** a first-class thing: a named set of riders sharing an approach. **Assigned to DAYS rather than to legs**—see the model note below, which was the load-bearing open question and is now settled. A boundary where the set of subgroups changes is a **meeting point** or a **split**, and both are DERIVED from the day list rather than stored; the `meet` and `split` roles stay labels and nothing reads them structurally.
- [x] Support multiple feeder approaches converging at **one or more** meeting points, possibly in stages: SF and Santa Cruz merge in San Jose, then that combined group meets the Oakland contingent in Dublin. Each feeder is a geographically distinct line ending at its meeting point; from there the merged group rides on as one shared leg. The same structure runs in reverse on the way home, splitting progressively.
- [x] Generate each rider's personal itinerary from the days they're on—their start point, their pickups, the shared trunk, their way back—so no rider has to mentally subtract the legs that aren't theirs.
- [x] Per-rider hand-off: the roadbook, the Google Maps links and all four file exports produce a rider-specific file—mine starts in Oakland, Dylan's starts in Sacramento—not one file for an abstract whole-group route nobody actually rides end to end.
- [x] Show it on one map: distinct approach lines converging on the meeting points, the shared trunk drawn once, and a way to focus a single rider's path (reuse the route-dim mechanism the day slider and legend hover already use).

**Open questions to settle when building.**

- **Model. SETTLED 2026-08-26: a feeder is a DAY.** `days.subgroup_id` nullable, null meaning everyone rides it. A subgroup owns a SUBSEQUENCE of the ride's dense positions, so `uq_day_ride_pos` never changed and a multi-day approach is simply more days. The rejected shape—legs carrying membership—reads better in this entry and breaks the settled rule that a day is ONE ORDERED LIST of points: two feeders cannot both start at position 0 of one list. Full argument in `docs/decisions.md`.
- **Timing. SETTLED and built**, in `src/subgroups/schedule.ts`: whose clock is pinned and which event is pinned are two separate axes, which is what dissolves the contradiction #143 was written with. A meet carries dwell AND slack, separately. **Solved but not yet SHOWN**—no surface calls the solver, and the roadbook is the obvious one.
- **Who edits. SETTLED by what exists**: the ride leader plans all of them. Subgroup leads planning their own approach IS collaborative editing, which is item 20 and is not built; `canEditRide` is owner-only and nothing on this branch changed that.

**Touches.** `src/db/schema.ts` (participant/leg assignment, or feeder-route structure), new or extended routes under `src/routes/`, `public/js/builder.js`, `public/js/viewer.js`, `src/maps/expand.ts` and the export path (per-rider hand-off), `src/maps/roles.ts` (`meet` / `split` become structural).

**Status.** **shipped 2026-08-26.** All nine boxes, including the proposed meeting point—@epim's idea in [#143](https://github.com/feralcreative/routeloop/issues/143), which this item absorbed. The proposer is pure geometry and calls no router. What is left is the timing SURFACE, above.

### 14. Alternate routes and group voting

**Goal.** Let a ride carry more than one candidate for a stretch—"over the pass" versus "the valley road"—and let the group vote them up or down, so the plan reflects what most people actually want to ride rather than whatever the organizer picked alone.

**Work.**

- [x] An **alternate** is a first-class thing: two or more candidate paths that share a start and end anchor and diverge between them. Exactly one is the **active** path at a time; the others ride along as recorded options rather than being thrown away. **Shipped 2026-08-16 at day level**, for a single planner—`days.alt_group` / `days.alt_active`, `src/maps/alts.ts`, and Group as alternatives / Ride this one instead / Ungroup in the builder.
- [ ] Up/down voting on each alternate—one vote per ride member, changeable until the decision closes—with a live tally.
- [ ] A resolution step: the ride leader promotes the winning alternate to the active path, or opts into auto-resolve by tally at a deadline. A losing alternate is kept, so a reversed decision doesn't lose the work. **Half of this shipped 2026-08-16**: promotion exists as a builder action and losing alternates are kept. Auto-resolve by tally needs the votes.
- [ ] Voting is scoped to invited ride members, never the public share link, and writes on a member's behalf so it needs the same abuse guardrails as any write.
- [x] Draw alternates distinctly—active path solid, alternates ghosted—and let a voter see each option on the map before voting. ~~Reuse the route-dim / hover machinery.~~ **Shipped 2026-08-16, with one correction: `setRouteDim` could _not_ be reused.** `entry.dim` is already owned by day focus in the builder and by hover and the timeline in the viewer, so ghosting through it un-ghosts an alternate the moment it is focused. `map-common.js` gained a third state, `entry.ghost`, drawn dashed with no direction arrows—a different _kind_ of line, because opacity already means "not focused".
- [x] Timeline and roadbook show the **active** path only; alternates never clutter the hand-off. **Shipped 2026-08-16**—`loadRideForExport()` filters unconditionally, so the roadbook, the hand-off page, the zip and all four lossy formats get it without each remembering to.

**Open questions to settle when building.**

- **Granularity. Answered 2026-08-16: day-level, and it was decided by import rather than here.** Item 21 lets a rider link two similar imported files as alternates for the same day, which is a whole alternate day and nothing else—so day-level is what the schema must carry first, and it reuses the rides-hold-many-days model as this entry hoped. Segment-level is not ruled out and still matches the "this way or that" pitch better; it is simply not what ships first. Worth noting the definitions did not have to bend: two candidates for one day share the day's overnight anchors and diverge in the middle, which is exactly the shape this item already describes.
- **Who proposes.** Only the ride leader, or any member? Any-member turns this into lightweight collaborative editing (backlog) and needs guardrails.
- **Resolution rules.** Simple majority, quorum, deadline, tie-breaking, and whether the leader can override the vote. Settle the governance before building the buttons.
- **Anonymous vs. named votes.** Named votes create social pressure; anonymous is cleaner but hides who wants what.

**Touches.** `src/db/schema.ts` (alternates + votes), new routes under `src/routes/`, `public/js/builder.js`, `public/js/viewer.js`, `public/js/map-common.js` (ghosted alternates), the timeline and roadbook (active path only).

**Status.** **shipped 2026-08-26.** The alternate object landed 2026-08-16 and the group-collaboration half—voting scoped to ride members, a live tally, and auto-resolve at an opt-in deadline—landed as [#153](https://github.com/feralcreative/routeloop/pull/153) once membership existed. Governance was settled narrowly and deliberately: **a tie elects nobody**, there is no quorum, and a deadline is opt-in per ride. `docs/decisions.md` says why each. A vote references a day by `uid`, which is what `days.uid` was added for.

**This item was split, and item 21 is why.** It bundled three things: the **alternate object** (two or more candidates for a stretch, exactly one active), the **voting**, and the **resolution**. Only the last two are group collaboration. The object landed on its own on 2026-08-16 with the builder able to create, switch and ungroup alternates for a single planner—so item 21 no longer sits behind riders (item 8), and the schema question was settled by a much smaller piece of work than this whole item, exactly as this note predicted.

**Two limits the shipped object carries, both accepted 2026-08-16.** A group member is exactly one day, so a **multi-day alternate**—"day 3 direct, or days 3b and 3c the long way with an overnight"—has no representation; that was chosen knowingly for the simpler shape, and adding it later means a third `alt_branch` column and a branch filter rather than a toggle. And **`MAX_DAYS = 31` now counts alternates**, so a 31-day ride cannot carry one. The cap's meaning changed quietly when the columns landed; **left as it is, deliberately**—31 days is already an extreme ride and the overlap with wanting alternates is negligible. It is documented here and in `docs/database.md` so the next person meets a stated limit rather than a mystery.

### 15. On-the-road mobile interface

**Goal.** A phone-sized, glove-friendly view of a ride for use in the saddle—big buttons, high contrast, no clutter—that does two things well: send the ride's files to whatever the rider navigates with, and step through a day's Google Maps legs one batch at a time. This is a **consumption** surface, not a planning one (planning stays a big-screen job), and it is the digital counterpart to the printed roadbook.

**Work.**

- [ ] A mobile layout for a ride: large tap targets, high contrast for sunlight, minimal chrome, usable one-handed. Reachable from any ride under the same visibility gate as the viewer—no account needed for a public or unlisted one.
- [x] **The Google Maps leg-loader (the headline).** List every batch from item 5 as a big button—"Day 2 · part 2 of 4"—that opens the Google Maps app on tap. Highlight the current batch, mark the finished ones, and make loading the next a single obvious tap the moment the last one ends. Remember progress per device (localStorage; no account required).
- [ ] **Send files to the device.** Offer the ride's exports (GPX, KML, …) through the phone's native share sheet / "open in"—the Web Share API with files where supported, a plain download otherwise—so a file lands in Garmin Drive, TomTom, or wherever the rider's app picks it up.
- [ ] Usable on spotty signal: once loaded, the leg-loader and its links should work without a connection, since the whole point is loading the next leg in the middle of nowhere. Leans on the PWA/offline groundwork in item 12.
- [ ] Fold in the roadbook data (stop order, leg and cumulative miles, miles since fuel, dwell) as an at-a-glance list, so the mobile page is the roadbook and the live hand-off in one.

**Open questions to settle when building.**

- **Where it lives.** A dedicated mobile route (e.g. `/m/:slug/go`) versus a responsive mode of the existing viewer. A separate, purpose-built page is probably cleaner than bending the map viewer to a glove.
- **Offline mechanism.** A full PWA (installable, service worker) versus a lighter localStorage cache of just the links and roadbook. Decide alongside item 12.
- **Batch boundary.** Whether the "next" button pre-fills the next batch's start with the previous batch's end so the rider isn't dropped between links (ties to item 5's batch-continuity question).
- **Web Share reach.** File sharing via `navigator.share` is uneven across iOS/Android browsers; define the plain-download fallback and what "send to device" means where the share sheet can't take a file.

**Touches.** new mobile route under `src/routes/` (a JSX page) plus a small `public/js/` controller, `src/maps/gmaps-links.ts` (item 5) and `src/maps/export.ts` as the data sources, the roadbook data, SCSS for the mobile layout, and the PWA groundwork in item 12.

**Status.** in progress—the leg-loader shipped as `/m/:slug/navigate` on `feat/expand-route`, listing every link per day with the density control. What remains is what makes it usable _on the bike_ rather than at a desk: glove-sized targets, marking finished legs, remembering progress per device without an account, and tolerating no signal. Overlaps the PWA/offline item (item 12).

### 16. The builder panel

**Goal.** The panel is the app's primary work surface and it has never been designed as one—it grew a control at a time. On a 1400px viewport it is 380px wide holding 198 interactive elements, and on a 3-day ride with 7 stops on the focused day its content is 807px tall in a 620px window. Everything below is from a measured pass on 2026-08-10 against `/builder/9`.

**Re-measured 2026-08-15**, same ride, same day, same viewport: **380px wide** (unchanged and deliberately so—the width was never the complaint), **180 interactive elements**, and content **618px in a 617px window**. The seven-stop day fits without scrolling, where it used to overflow by 187px. Take this measurement again before closing the item; a number is the only thing that can say whether the redesign did anything.

**The governing rule.** **Nothing in the panel changes size as its value changes.** This is a constraint on every item below, not a task of its own—reserve the space, fix the footprint, and let content fit the box rather than the box track the content. Jumping layout is the single most jarring thing about the panel today, and it comes from a dozen small places rather than one:

- The **day band** is `hidden` until a day is picked, so the panel goes 482px → 696px on one slider move. The largest single jump.
- Per row, the **notes textarea** and the **17-button role picker** are both `hidden` and expand inline, pushing every row below them.
- The **role icon button** grows with the number of roles (see below).
- Variable-length readouts reflow what follows: `#totals`, `#save-status`, `#day-times-note`, `.day-pick-hint`, the `#search-results` list, and the recover bar.

**Work.**

- [x] **Autosave to the server; retire the Save button.** Shipped 2026-08-15. Two timers rather than one: a 3s idle debounce, and a 20s ceiling armed on the first edit of a dirty run and not re-armed by later ones. The ceiling is the one that matters—an idle debounce alone has no upper bound, so dragging a stop around for four minutes never goes idle and never saves. Both sit far under the five-minute acceptance bar deliberately, because the bar is what must never be exceeded rather than what to aim for. The route request keeps its own debounce in `computeLeg()` and is not coupled to this; that is the half that costs money. Save and Discard are both gone.
- [x] **Say that autosave is happening.** Shipped 2026-08-15. A dot and a word in the action row, in a **fixed-width box**—it was on the governing rule's list of variable-length readouts, and it cycles three states several times a minute right beside the link to the public page. A server error ellipsizes rather than being allowed to set the width. The readout is `aria-hidden` and a separate live region speaks only for an error or a blocked save; a polite region on the readout itself would announce the routine cycle aloud several times a minute.
- [x] **An X in the panel's top corner that exits the map.** Shipped 2026-08-15, and **half of this entry turned out to be wrong**. The existing control was never an X—`panelShell` renders `icon-collapse.svg`, a minimize glyph—so there was no wrong verb to fix and collapse did not have to move anywhere. What was real was the other half: there was **no exit at all**. A map page has no footer and its header is the floating nav, so the only way off was the hamburger in the opposite corner. An exit now sits beside collapse in `.panel-controls`, two controls for two verbs: collapse keeps you on the map, exit leaves it. It lands on the **viewer** as well, which was the same black hole, and goes to `/rides` for a signed-in rider or `/` for a visitor who followed a shared link and has never seen the site.
- [x] **Drag to reorder, not arrows.** Shipped 2026-08-15, closing [#39](https://github.com/feralcreative/routeloop/issues/39). **SortableJS 1.15.7 from jsdelivr**, pinned with an SRI hash and `crossorigin`, approved as a dependency the same day; `forceFallback` is on so a drag behaves the same on a phone and a laptop rather than taking the browser's native path on one and Sortable's own on the other. **The index mapping was the whole job**: `orderedRows()` interleaves stops and POIs by distance along the track while each row's `data-i` indexes its own array, so Sortable's `oldIndex`/`newIndex` mean nothing here—reading the DOM order of the stop rows and taking their `data-i` sidesteps the interleaving entirely. Only stops drag; a POI's place is projected, not stored. A drop is a **move**, not the neighbor swap `moveStop()` does, and only legs `[min−1, max]` are recomputed rather than the whole day, because every one of them is a billable routing request.
- [x] **One menu per row, not a row of buttons.** Shipped 2026-08-15. Six buttons became two—a drag handle and a `⋯`. The menu is built on open and only one exists at a time, per the warning this entry already carried. It is absolutely positioned inside the row, so opening it moves nothing. **Move up and Move down live in it as well as on the handle**, which is not redundancy: a drag handle cannot be operated from a keyboard, and they are also what still works if the CDN fails. Duplicate is genuinely new, and it copies `roles` rather than sharing the array—`builder-history.js` warns that its shared-by-reference set changes whenever a feature like this lands, and this is that feature.
- [x] **The two sliders are eating the panel.** Shipped 2026-08-15, and neither merged nor tightened—**the ride timeline left the panel entirely** and is now a bar across the bottom edge of the map, on the viewer as well as the builder. That is where the Vision has always put it ("a slider across the bottom of every ride and day"), and it resolves the view/edit split the entry asked for by separating the two controls rather than the two modes: the day scrubber picks what you are **editing** and stays beside the edit controls, the timeline moves through what you are **looking at** and belongs over the map. The move cost almost no JS—both clients reach `#time-slider` and `#time-readout` by id and neither walks up from them—so it was markup plus one shared `rideTimeline()` in `src/views/layout.tsx`, which also ended the two drifting copies (the viewer's carried `hidden`, the builder's did not). **The disabled state is gone**: over the map the bar hides outright when a ride has no dates, because the reason it stayed put in the panel—vanishing would reflow everything under it—does not apply when there is nothing under it. The hint it used to carry moved to `#day-times-note`, beside the Starts field that fixes it. Three things the bottom edge is not free of, all measured rather than guessed: Google's wordmark and attribution are a **license condition** and may not be covered, the zoom and recenter buttons own a gutter at RIGHT_BOTTOM, and on a phone the panel is already the full width—so the bar clears the credit strip and the control gutter on both layouts, and the phone stacks the panel above it through `:has(.map-timeline:not([hidden]))` so a dateless ride reserves nothing.
- [x] **The ride's name is the headline.** Shipped 2026-08-15. The input **is** the heading rather than something a pencil swaps in—a reveal would be a second mode and a layout jump, which is the thing the governing rule exists to remove. The field is drawn as the heading, carries no border until hovered or focused, and shows the pencil then as an affordance. The summary moved directly under it and both now sit outside `.panel-contents-wrapper`, so they stay put while the stop list scrolls; `renderTotals()` writes `#totals` by id and did not notice. Note this also fixed something unrelated that nobody had filed: on a **new** ride the panel had no `<h1>` at all, so a collapsed panel showed an empty strip.
- [x] **The action row is icons, not labels.** Shipped 2026-08-15, and the sequencing paid off exactly as predicted: autosave had already deleted Save and Discard, so what got drawn was undo, redo, a status readout and the link to the public page—the row that survives rather than the one that existed. Undo and redo were U+21B6 and U+21B7 for most of that day on the reasoning that a standard character beats an asset, and **that was wrong in this particular box**: Overpass draws both as hairline strokes, so at 15px they read as faint tick marks rather than as arrows, and at the disabled state's 0.35 opacity—which is what a rider sees most of the time, since undo starts with nothing to undo—they very nearly vanish. They are `icon-undo.svg` now, one path with real weight to it, **and redo is that same file mirrored** with `scaleX(-1)`. One file rather than two because undo and redo are the same gesture in opposite directions and two drawings are two chances for the arrowheads to disagree. Both are `.tb-inline-icon` rather than `<img>`, so the SVG is inlined and its `fill="currentColor"` can take the button's color, disabled state included; an `<img>` would stay black while the button grayed out around it. **The fold is fixed too:** `.builder-actions` was `position: static` at the end of a list that grows without limit, so the controls a rider reaches for most were the ones furthest out of reach—140px below the visible area on a seven-stop day. It is `position: sticky; bottom: 0` now, with an opaque background because content scrolls under it.
- [x] **Stop durations show as hours with one decimal, and the format is a preference.** Shipped 2026-08-15, closing the epic. Storage did not change: `points.duration_min` is still integer minutes, so the roadbook, the timeline and all six exports were untouched and this was a formatter plus a setting, exactly as scoped. `src/maps/duration.ts` owns the rule, `public/js/duration.js` mirrors it, and `test/duration.test.ts` pins the two—plus a **third** copy nobody had counted, `fmtDuration()` in `src/routes/roadbook.tsx`, which already printed `4h 20m` and whose own comment records the same complaint this entry is about ("an overnight camp stop printed 658m"). The builder had never got that fix, so one stop read 658 in the panel and 10h 58m on the printout. The `hm` format is now defined as agreeing with the roadbook rather than the other way round. **The field is `type="text"` now**, because "1h 30m" is not a number and switching the input's type per format would be three code paths through every read and write; `inputmode` comes off the format instead. That lost the markup's `max="43200"`, so the ceiling moved into the parser, where it clamps rather than refuses—a fat-fingered `800h` settles to `720h 0m` on blur instead of 400ing the ride's next autosave. Two behaviors worth keeping: **it parses on every keystroke and reformats on none of them** (rewriting as you type strands the caret, and `1h` followed by a space becomes `1h 0m` before the minutes are typed—tidying is the blur handler's job), and an unparseable value stores null rather than holding the last good number, so a typo and an empty field mean the same thing. **Amended 2026-08-29 by #189:** the hours format carries **two** decimals, not one. At one place its smallest expressible stop was six minutes, so the blur handler's tidy-up silently rewrote every value off that grid—a 15-minute coffee stop came back `0.3` and read as 18 the next time anything parsed it—and `.25`, which is how a rider writes a quarter hour, matched no rule at all and emptied the field. Two decimals round-trip all 43,201 storable minutes, asserted exhaustively rather than by sampling; the old test allowed a three-minute loss and the corruption fitted inside it.
- [x] **Color pickers are square.** Shipped 2026-08-15. Scoped to `input[type="color"]` rather than to `#day-color`, since it is true of any color input. 50 × 27 became 27 × 27 and the day-name field went from 165px to 194px. The swatch needs `::-webkit-color-swatch` and `::-moz-color-swatch` told to fill the box, or a square input holds a small rectangle floating in the middle of it.
- [x] **Role icons get a fixed footprint.** Shipped 2026-08-15. **The how, which this entry left open, is the first role's icon at full size plus a `+n` count**—stacking and a quarter-scale 2×2 grid were the other two candidates and both lose legibility at 16px, which is the size that matters. Roles cap at 4, so the badge never exceeds `+3`, and every role's name is joined into the button's `title`, so nothing is hidden, only summarized. Measured: the button holds 43px and the name field 137px at 0, 1, 2, 3 and 4 roles.

**Open questions.**

- **Whether exiting needs a guard at all. Answered by autosave: no dialog.** Nothing to lose means nothing to confirm, and with the flush shipped the ride is on the server within three seconds of the last keystroke. The `beforeunload` guard narrowed rather than vanished—it now fires only for the genuine window, an edit inside the debounce or a flush in flight, and in practice a rider never sees it. That also removes the "un-dismiss the exit confirmation" entry from `/settings` in `docs/main-menu.md`, leaving the duration format below as its only decided content.
- **Save churns IDs. Decided 2026-08-15: accept it, and guard it.** The `PUT` deletes and re-inserts every day and point, so identifiers change on each save, and autosave now makes that happen constantly rather than a dozen times a session. It stays safe for exactly one reason—nothing anywhere references a point across a save—and the alternative was to send ids in the payload and diff server-side, which rewrites `insertRideGraph`, `ridePayload` and `loadRidePayload`, the path the native JSON import shares, for a bigger job than the rest of item 16. The constraint is written on the `PUT` handler in `src/routes/builder.ts` where the next person will hit it: **anything that needs a point to keep its identity has to fix this first**—rich stop details (item 11), a comment on a stop, a photo attached to one. The failure is silent and looks like data that wandered off.
- **Does a view/edit mode split contradict the vision? Answered 2026-08-15: there is no mode split.** The question assumed the only way to stop the two sliders competing was to put one behind a view mode, which would have meant the timeline was absent while planning—a change to a stated headline feature. It was the wrong axis. The two controls are not two modes of the same thing: one scrubs time across the whole ride and one picks the day being edited, so they separated by **place** instead. The timeline went to the map's bottom edge, where the Vision already describes it, and stays visible the entire time a rider is planning. Nothing about the Vision had to bend.
- **Where the fold falls. Answered by the action row, 2026-08-15.** `.builder-actions` is `position: sticky; bottom: 0` with an opaque background, so undo, redo and the status readout are in reach at any list length. Worth recording what the fold measures now: on the ride the epic's baseline was taken from—`/builder/9`, day 2, seven stops, 1400×900—the panel's content is **618px in a 617px window**, so the seven-stop day no longer scrolls at all. It was 807px in 620.

**Touches.** `src/routes/builder.ts` (the panel markup and `PUT /api/rides/:id`—renamed from `rides.ts` in [#104](https://github.com/feralcreative/routeloop/pull/104)), `src/views/layout.tsx` (`panelShell` and `rideTimeline()`, both shared with the viewer—so the collapse/close change and the timeline move land on both), `src/index.tsx` (the viewer shell), `public/js/builder.js`, `public/js/viewer.js`, `public/js/builder-history.js`, `public/js/duration.js` + `src/maps/duration.ts` + `test/duration.test.ts`, `style/_builder.scss`, `style/_map.scss` (the panel frame, the timeline bar and the page's custom properties), `style/_account.scss` (the settings sections), `src/routes/settings.tsx`, `src/db/schema.ts` + `drizzle/0002_keen_sasquatch.sql`, `docs/ops/faq.md`.

**Status.** done, 2026-08-15, merged to `main` via [#106](https://github.com/feralcreative/routeloop/pull/106) and **not yet deployed**—opened 2026-08-10 from a click-through, shipped in five phases over one day. Nothing here existed on the roadmap before; the builder panel had never been an item. All eleven boxes are ticked and every open question is answered. **One thing still outstanding:** the schema change in it (`user_profiles.duration_format`, `drizzle/0002_keen_sasquatch.sql`) has been applied to the local dev database only—stage and production have not seen it, and the deploy is what applies it. Note the panel has moved on since: `feat/fixed-day-slider` replaced the floating panel with a left drawer showing every day.

### 17. Avatar upload

**Goal.** Let a rider upload their own avatar from the profile page. `users.avatar_url` exists but is write-once from Google sign-in; a magic-link rider has none and never can, and the profile page has no avatar section at all.

**Work.**

- [ ] **A section at the top of the profile page, beside the username**, holding the avatar, the upload control, and remove-and-revert-to-fallback. Placement decided 2026-08-15.
- [ ] **Raster only. No SVG, ever.** Decided 2026-08-10—an SVG avatar is stored XSS, and `src/views/layout.tsx` renders the avatar in the nav on every page of the app. This is a security boundary, not a format preference.
- [ ] **PNG or JPEG only, 1 MB maximum.** Added 2026-08-15. The two format names are the concrete expression of the raster-only rule above—accept exactly these and reject everything else by sniffing the bytes, not by trusting the extension or the `Content-Type`. The 1 MB bound is a cheap first gate that rejects most of what a phone camera produces before any decode happens, which matters because decoding is where a malicious image does its damage.
- [ ] **Square, 500×500 maximum.** Decided 2026-08-10 and reaffirmed 2026-08-15 against a 1000 proposal. Stored square; **circular is a display treatment only**—`.nav-avatar` already carries `border-radius: 50%`, so nothing round is ever written to disk.
- [ ] **A circular crop box the rider sizes and positions**, working on any aspect ratio—decided 2026-08-10, in place of a server-side center-crop, which beheads anyone who uploads a landscape photo. The circle is the _guide_; what gets written is the square that bounds it, so the corners are still stored and a square display keeps working if we ever want one. **Outside the circle is shaded**, not hidden, so the rider can see what they are cutting off while they position it.
- [ ] **Re-encode every upload server-side** to a known raster format at or under that bound. Never store or serve the bytes as received. **The client-side crop is convenience, not enforcement**—the browser's output is attacker-controlled, so the server re-validates dimensions and re-encodes regardless of what arrived.
- [ ] Strip EXIF—phone photos carry GPS, and a rider's avatar should not publish where they took it.
- [ ] Serve through a route, not a static path: `src/maps/storage.ts` deliberately writes outside the web root, and avatars follow the same rule.
- [ ] Confirm `STORAGE_PATH` is a named volume in prod before anything user-uploaded depends on it surviving a redeploy.

**Open question.** **Which crop library, if any.** Pinch-zoom, drag-to-position and touch handling on a crop box is a lot of fiddly work to get right, and this is the first item on the list that plausibly earns a dependency rather than bespoke code. See the standing preference in `AGENTS.md`: a library that earns its keep is welcome, options get presented rather than assumed.

**Touches.** `src/routes/profile.ts`, `src/maps/storage.ts` (or a sibling that follows its containment pattern), `src/db/schema.ts` if the source of an avatar needs distinguishing from Google's, `src/views/layout.tsx`.

**Status.** planned—raised 2026-08-10. This is the first user-uploaded binary the app serves _publicly_; the stored map originals are downloads behind auth, which is a materially different risk profile. The initials-on-a-tinted-disc fallback stays for riders who upload nothing—see `docs/main-menu.md`.

### 18. Profile autosave

**Goal.** The profile saves on a button today, so a rider who edits a field and navigates away loses it silently. Autosave after a few idle seconds, the way an editor does, and say so.

**Work.**

- [ ] Flush the profile form to the server after a short idle pause, and on blur of the last-touched field.
- [ ] An indicator that says saved / saving / failed, in place of the button it replaces. Silent saving is worse than an explicit button, not better.
- [ ] Per-field validation errors already come back from the `profile.tsx` schema; an autosave has to surface them without stealing focus or reverting what the rider typed.
- [ ] Decide what happens to a partially valid form. A profile is not a ride: individual fields are independent, so a bad postal code should not block a good display name from persisting.

**Sequencing against item 19—build this one first, and leave the address block out of it.**

Autosave and address autocomplete both watch the same fields and both act on a pause in typing, so shipped naively they fight: a rider types four characters of a street name, stops to read the suggestion list, and the idle timer fires and saves the fragment. The stored address is now `123 Ma`, the geocode against it is wrong or null, and if the save re-renders the field from the server the dropdown closes underneath them mid-choice.

- [ ] Build autosave with the address block **excluded**, saving every other field on idle. The address fields keep their explicit save until item 19 lands. This is a real state to ship in, not a stepping stone—the rest of the profile is the part with no save affordance problem.
- [ ] When item 19 lands, the address block joins autosave on a **different trigger**: it flushes when a suggestion is _selected_, or when the field is left with the dropdown closed. Never on an idle timer, because idle is exactly the state a rider is in while reading suggestions.
- [ ] Whichever ships second owns the integration test: type into an address field, pause longer than the idle delay with the dropdown open, and assert nothing was saved and the dropdown is still there.

**Open question.** **Whether it shares a mechanism with item 16.** The builder's autosave has the same shape—idle debounce, flush, status indicator—but a different failure model: the builder's `PUT` replaces the whole ride in one transaction, while a profile is a set of independent fields. Worth one helper if the debounce and the indicator are genuinely the same; not worth forcing if the persistence halves differ. Look at both before writing either.

**Touches.** `src/routes/profile.tsx`, `public/js/profile.js`, `style/_forms.scss`.

**Status.** planned—raised 2026-08-15.

### 19. Address autocomplete that fills the form

**Goal.** Typing an address should offer matches in a dropdown attached to the field, and picking one should fill address, city, state and postal code in a single action. Today the rider types every field by hand and a status line appears _below_ the input reporting what the geocoder made of it, which is feedback after the fact rather than help during.

**Work.**

- [ ] Attach a suggestion dropdown to the address input itself, replacing the after-the-fact `#geocode-status` line as the primary feedback.
- [ ] On selection, populate `addressLine`, `city`, `state` and `postalCode` from the structured result, plus the coordinates the geocoder already writes—one action instead of five fields and a guess.
- [ ] Apply to **both** address blocks on the profile: the home address and the separate ride-start address, which are two copies of the same five fields today.
- [ ] Keep manual entry working unchanged. An address the provider does not know must still save as typed—the existing rule that a bad geocode yields null coordinates and never a validation failure stays exactly as it is.
- [ ] Keyboard-navigable list with the usual arrow/enter/escape semantics and correct ARIA, not a mouse-only menu.
- [ ] **Take over the address block's persistence from item 18**, which deliberately ships with those fields excluded from idle autosave. Flush on selection, or on leaving the field with the dropdown closed—never on an idle timer, which is the state a rider is in while reading the list. See the sequencing note under item 18 for why.

**Open questions.**

- **Which API, and what it costs.** Places Autocomplete (New) is already enabled for the builder's search box, but it is billed per session and per request, and this puts it behind every keystroke on the profile. Session tokens are the mechanism that keeps that from being priced per character—use them, and confirm the SKU before it ships. The daily quota caps from item 1 apply.
- **Server proxy or browser call.** The builder calls Places from the client with the referrer-restricted browser key; the profile's geocoding was deliberately moved _server-side_ in item 1 so `GMAPS_SERVER_KEY` never reaches a client. Decide which side this sits on rather than inheriting whichever is nearer to hand.
- **Coverage outside the US.** The four field names are US-shaped. A provider returning a structured result for an address that does not decompose that way should degrade to filling the line and leaving the rest, not to filling them wrongly.

**Touches.** `src/routes/profile.tsx`, `public/js/profile.js`, `src/routes/routing.ts` (the existing geocode proxy), `style/_forms.scss`.

**Status.** planned—raised 2026-08-15. Related to item 6 (saved places), which will want the same picker when a rider adds a place.

### 20. Theme selection: three themes, each in light and dark

**Goal.** Two independent controls on the preferences page. **Theme**—default, high contrast, colorblind—chooses the palette. **Appearance**—system, light, dark—chooses the scheme. They do not constrain each other: every theme exists in both schemes, six palettes in total. This lands on `/prefs`, beside the stop-duration format that shipped 2026-08-15—so it is the page's second and third settings rather than its first, and the first time it holds enough to need a layout at all. See item 22.

Two axes rather than six radio buttons, decided 2026-08-16. The two questions are genuinely unrelated—theme is about which signals a rider can distinguish, scheme is about ambient light—and collapsing them into one list would ask a rider to find "colorblind dark" in a flat six. It also makes _system_ expressible, which a single list cannot do: "follow the OS" is a statement about the scheme axis only, and there is no OS signal for colorblindness.

**Work.**

- [ ] Two preferences, persisted to the account and applied server-side on render so there is no flash of the wrong theme. Note the asymmetry before building it: theme and an _explicit_ light or dark can both be rendered from the stored value, but **system cannot**—the server does not know the OS setting. See the emission shape below; it is solvable without JS, but not by rendering an attribute.
- [ ] **Default** is the road-sign palette as it stands, including the ink pairing—which field takes the white legend and which takes the black—recorded in `style/_tokens.scss`.
- [ ] **High contrast** raises every foreground/background pair well past 4.5:1, including the pairs that only just clear it today and the ones that deliberately do not because they are decoration rather than text.
- [ ] **Colorblind** addresses the collisions the palette has by construction. `$stop` and `$go` are a red/green pair and converge under deuteranopia and protanopia; `$yield` and `$construction` are adjacent ambers. The existing note under the `/import` filename fields—that color is never the only cue—becomes a rule the whole app has to hold to, not a line in one comment.
- [ ] Audit where color is currently the _only_ signal and give each a second cue (shape, icon, label, weight) before the colorblind theme claims to work. A theme that only shifts hues does not fix a signal that was carrying meaning alone.
- [ ] **Dark** for each of the three. Scope this off the finding below—it is a neutral-scale and surface job, not a repaint of the road-sign palette.

**What dark mode actually touches—surveyed 2026-08-16.**

The road-sign palette does not move. The ink-pairing table in `_tokens.scss` is copied off real signs rather than derived from contrast math, and a sign's colors do not change at night: `$stop` is the same red on an unlit road, still carrying a white legend. So `$interstate` through `$tarmac`, and which ink each field takes, are **scheme-invariant**. What inverts is the page around them—body text, surfaces, borders, panel fills. That is a much smaller surface than "six palettes" suggests, and it is the finding that makes this worth doing now rather than later.

Three things already in the repo help more than expected:

- **The neutral scale is numbered by CIE L\***, so the dark ramp is expressible rather than hand-picked: roughly `$neutral-N` → `$neutral-(100-N)`. Only roughly—a dark UI wants less contrast than a naive flip gives, because light text on dark blooms—but a scale whose numbers mean something can be mapped and checked, which a 50–900 ordinal could not.
- **`$splash-ink` (#0a0e11) is already the app's dark surface**, and `src/emails/theme.ts` already mirrors it as `DARK.cardBg`. The dark scheme should start there rather than inventing a second near-black, and doing so quietly narrows the email/site split noted below.
- **The logo lockups already ship `-dk` reversed variants** (`layout.tsx`, two places). Dark mode needs to drive that switch globally instead of per-page—a work item, but not new artwork.

And two things cost more than expected:

- **The derivation direction inverts, which breaks the mechanism as decided.** The 2026-08-15 decision was that the formula is written once and applied per theme. That holds across the three _light_ themes because every legibility derivation darkens—`$pending` is `-20%`, `$label` is `-22%`, both making a yellow survive as text on white. On a dark ground the same tokens have to _lighten_. The fix is to carry a direction with the scheme and write the expressions signed, so `-20%` becomes `-20% * $dir`; the formula stays written once. **The trap is assuming that makes the contrast symmetric.** It does not: +20% on a dark ground and -20% on a light one land on different ratios, so all six palettes need their figures measured, not inferred from the light ones. Budget for six contrast audits, not one plus five reflections.
- **The hover-direction rule inverts too.** `_tokens.scss` documents at length that a black-legend field must get _lighter_ on hover, not darker, or `$go` falls from 6.1:1 to 4.3:1. Under a dark scheme that reasoning has to be re-derived per field. This lands squarely on the 46 inline derivations below, and it means the migration cannot treat them as a flat list—each has to be classified as **legibility-derived** (direction flips with scheme) or **decorative** (may not). That classification is the real work and it should happen during the promotion step, when each one is being touched anyway.

**Mechanism—decided 2026-08-15, extended for the scheme axis 2026-08-16: Sass generates, custom properties carry, `data-theme` and `data-scheme` switch.**

The obstacle is that several tokens are _derived_ rather than authored—`$pending` is `color.adjust($yield, -20%)`, `$label` is `-22%`—and Sass runs at build time, so it cannot recompute them when a custom property changes at runtime. Three ways out, and the third is the one to take:

1. **Author every derived value per theme.** Three themes times every derived token, maintained by hand. It throws away the property the palette was just given—one source per hue—and guarantees drift the first time a base color moves.
2. **Move the derivations to `color-mix()` in CSS.** Genuinely runtime-derivable and well enough supported. But it relocates color arithmetic out of the one file that documents it, and the contrast figures the palette is built on stop being checkable in the place the values live.
3. **Keep the derivations in Sass and loop over a theme map.** A `$themes` map holds only the _authored_ palette per theme; an `@each` emits a `:root[data-theme="…"]` block per entry, running the same `color.adjust` expressions against that theme's own base colors. The formula is written once and applied once per palette—six times, with the scheme axis. Adding a fourth theme is a map entry, not an edit in N places. No runtime color math, no browser-support question, and the derived relationships stay honest per theme—high contrast's amber darkens by its own amount from its own base.

**The real migration cost is not the tokens, it is the 46 inline derivations.** `color.adjust($gpx, -8%)` and friends appear 46 times across the partials, in rules rather than in `_tokens.scss`—hover states, borders, tints. Every one of them reads a Sass variable that will no longer hold the live value once a theme can change it, and `color.adjust()` cannot operate on a `var()`. Each has to become a token emitted per theme. That is the bulk of the work and it should be sized before anything is drawn.

The `$themes` map is therefore nested—keyed by theme, each entry holding a `light` and a `dark` authored palette—and the `@each` runs twice per theme.

**The emission shape, and why _system_ forces it.** A stored preference can be rendered into an attribute; the OS setting cannot. Emitting three blocks per theme solves it with no JavaScript and no flash, because the media query is the fallback and the attribute is the override:

```scss
:root[data-theme='#{$name}'] {
  /* light tokens—the default when no scheme is asked for */
}

@media (prefers-color-scheme: dark) {
  :root[data-theme='#{$name}']:not([data-scheme='light']) {
    /* dark tokens—system, unless light is pinned */
  }
}

:root[data-theme='#{$name}'][data-scheme='dark'] {
  /* dark tokens again—pinned dark wins in both directions */
}
```

_System_ then renders as no `data-scheme` attribute at all, and the `:not()` is what lets a rider pin light while their OS is dark. Three themes times three blocks is nine copies of the full token set in the stylesheet—worth measuring the compiled size once the first theme lands, though custom-property declarations compress well and this is unlikely to be the thing that matters.

**Work, in order.**

- [ ] Promote all 46 inline derivations to named tokens, **classifying each as legibility-derived or decorative as it is promoted**. No behavior change, and it can land on its own well before any theme exists—which is the point of doing it first. The classification is what the scheme axis later depends on, and it is nearly free while each one is already open.
- [ ] Restructure `_tokens.scss` around a nested `$themes` map with one entry, `default`, holding only a `light` palette and emitting today's values as custom properties. Still no behavior change; the compiled output should be equivalent.
- [ ] Add `dark` to `default` and sign the derivation expressions. This is the step that proves the mechanism, and it should be first because it is the one that can fail—if signed derivations do not hold their contrast figures, better to learn it against one palette than three.
- [ ] Measure all contrast pairs for `default` dark. Do not carry the light figures across.
- [ ] Add `high-contrast` and `colorblind`, each with both schemes, measuring each.
- [ ] Wire both preferences, the `data-theme` and `data-scheme` attributes, and the `-dk` logo swap.
- [ ] Delete the comment at `style/_dashboard.scss:24`, which states the app has no dark mode and that only the emails do. It becomes false the moment this lands, and it is exactly the kind of comment that outlives its truth.

**Open questions.**

**Decided 2026-08-16: the map does not invert.** Dark chrome around an unchanged map, the same way a photograph is not inverted in dark mode—the map is content, not chrome. This costs nothing to build and is the only option that keeps `terrain`, which `map-common.js` argues at length is the point of the whole basemap block: relief is the single most useful thing a map can say about a road that a line on white cannot.

The alternative was a second Map ID switched at runtime, and it fails on its own terms. Terrain is raster imagery with vector data drawn over it, so cloud styling reaches only the labels and roads and never the ground—meaning a dark scheme could not darken terrain at all, only replace it with a dark `roadmap`. That trades the default basemap, and the reason it is the default, for a darker rectangle. **So this item touches no map code**, which is also what removes `public/js/map-common.js` and a second Map ID from its Touches list.
- **The splash page is the opposite of a problem.** It was listed as a reason to defer dark mode, but `_splash.scss` already opts out of the light chrome because the footage is dark. Splash is effectively dark-native; the odd case is what it means in _light_ mode, which is "unchanged". That objection can be retired.
- **Does the theme axis interact with `prefers-contrast`?** The OS reports it. Whether `prefers-contrast: more` should auto-select the high-contrast theme, or whether theme stays a pure stored preference with no OS input, is undecided. Note this is now cleanly separable from the scheme question, which is one benefit of splitting the axes.
- **The emails.** `src/emails/theme.ts` carries its own dark palette, pinned to `_tokens.scss` by `test/email-theme.test.ts`. Once the site has real dark tokens, either the emails adopt them or the split becomes deliberate and documented. The pinning test is the place that will notice first, and that is the test doing its job.

**Touches.** `src/routes/prefs.tsx` (renamed from `settings.tsx`—see `docs/main-menu.md`), `src/db/schema.ts` (both preferences), `src/views/layout.tsx` (applying both at render, plus the `-dk` lockup swap), `style/_tokens.scss` and every partial that reads a token, `style/_dashboard.scss` (the stale comment), `docs/main-menu.md`. **Not** `public/js/map-common.js` and not a second Map ID—the map question resolved against touching either. The two radio groups this adds are item 22's motivating pair, so land the width work first or draw them knowing it is coming.

**A dependency the feedback sprint created, and it is easy to miss.** `style/_feedback.scss` is pinned to LIGHT values with no `prefers-color-scheme` block, deliberately: the intake flow is used outdoors in bright sun, so `.feedback-flow` is light-mode-first regardless of the system theme. **The scheme axis must skip that surface** rather than inverting it along with everything else.

**Status.** planned—raised 2026-08-15, widened to light and dark 2026-08-16. Overlaps the accessibility pass in item 12; this is the color half of it, and item 12's line should be read as the keyboard/focus/ARIA half once this exists.

<!--| PAGE-BREAK -->

### 21. The import review table

**Goal.** Today the drop box reads what it can off the filenames and _shows_ it. A rider who sees a wrong date, a missing ride name or the wrong day order has no way to fix it except renaming files on disk and dropping them again. Make the preview an editable manifest: ride name, per-route name and per-route date all editable in place, day order draggable, any row droppable, and duplicates surfaced and resolved—all before a single row is written.

The pitch in one line: **guess harder, then let the rider correct the guess.** Those two halves depend on each other, and neither is worth much alone.

**What already exists and must not be rebuilt.**

- **`planImport()` in `src/maps/filename.ts` already returns the manifest.** It hands back `ride`, a `files[]` of `{ fileName, index, day, date, hasTime, title, ext, conforming }`, and the three flags `allConforming`, `reordered` and `rideConflict`. This item is that structure made editable and posted back—not a new parse.
- **Row drag is already solved.** SortableJS 1.15.7 is a pinned dependency with an SRI hash, in use for stop reorder since item 16. Use the same library and the same textured handle rather than inventing a second drag pattern on a second page. Item 16's hard-won lesson comes with it: **a drag handle cannot be operated from a keyboard**, so move-up and move-down must also exist as real controls, and they are what still works when the CDN fails.
- **`titleFromSlug` already recovers a display title** from a slug field, and its comment already records that a file's own internal name is preferred over anything recovered from a filename. Staging makes that internal name available before the table renders, which is the first time that preference can actually be honored in the preview.

**Three consequences that _are_ the item. The table is the easy half.**

1. **Import becomes two-phase: stage, review, commit.** `POST /api/maps` currently validates every file and inserts in one call, and `filename.ts` states the invariant plainly—the drop box previews `planImport()` and the endpoint acts on it, "so the two cannot disagree about what a folder means." **An editable manifest breaks that by design.** Once a rider can retype a date, the server cannot re-derive the truth from filenames; the edits _are_ the truth. The endpoint has to accept a posted manifest and validate it, and the invariant weakens from "both compute the same answer" to "the server validates what the client sends"—which is a real loss of safety and has to be replaced with explicit validation rather than quietly dropped. **The comment in `filename.ts` must be rewritten when this lands**; it will otherwise sit there reading as still-true.
2. **Duplicate and similarity detection need the bytes, not the names.** An exact duplicate is a content question and a similar route is a geometry question, and neither can be answered from a filename. So the files must be uploaded and parsed _before_ the rider sees the table—the review step cannot be client-side-only, which is what the current drop box is. That is the staging half, and it drags its own tail: staged bytes count against quota, so they need a TTL and a sweep, and the "all files are validated before any is parsed, so a bad tenth file names itself" guarantee documented in `docs/api.md` moves to the stage call rather than disappearing.
3. **Aggressive gleaning becomes safe, and today it is not.** `filename.ts` deliberately refuses to guess: without the marker, `parseExportName` returns null and a rider's own `day-2.gpx` is never silently reinterpreted. That rule is correct _because the guess would be invisible_. A review table removes its reason for existing—a guess the rider sees and can overwrite before commit is not a silent reinterpretation. So the strict convention stays **exactly** as it is for conforming names, and a **separate best-effort layer** reads the rest: dates in other spellings, `day 2` / `Day-2` / a trailing number, a title from whatever is left over. Keep the two layers apart and show per cell which one filled it, so the strict parser's guarantees are not diluted by the guesser's. A cell the app is unsure of should look unsure.

**Work.**

- [ ] Split the import into stage → review → commit, with the manifest posted back rather than re-derived. Replace the lost invariant with explicit server-side validation of the posted manifest.
- [ ] TTL and sweep for staged uploads, and decide how staged bytes hit the storage quota.
- [ ] The manifest table: ride name, per-row route name, per-row date, all editable in place; drag to reorder days, with keyboard-reachable equivalents; a per-row drop control that excludes a file from the import without re-dropping the folder.
- [ ] The best-effort gleaner, as its own module beside `filename.ts` rather than inside it, with per-cell provenance surfaced in the table.
- [ ] Prefer the file's internal track name over the filename-derived title now that staging makes it available.
- [ ] **Exact duplicates**—called out, with a one-click drop of the copy.
- [ ] **Similar routes**—called out as **candidate alternates for the same day**, linkable right there in the table rather than by opening the builder afterwards. Decided 2026-08-16, and it is the point of the feature: a rider who drops two files for day 2 is telling you they have two ways to ride day 2.
- [ ] Pick which linked candidate is **active**. Item 14 requires exactly one at a time; on import the sane default is the first in day order, with the table able to change it before commit. **The mechanism exists as of 2026-08-16**: set `altActive` on one member of an `altGroup` and the server elects it. If the manifest names none, `resolveAltGroups()` elects the lowest-indexed member, which is already "first in day order".
- [ ] Rewrite the "the two cannot disagree" comment in `src/maps/filename.ts`.
- [ ] Extend `test/round-trip.test.ts`'s sibling coverage to the manifest: an edited manifest must produce exactly the ride it describes, which is the only assertion that catches an edit being silently ignored.

**Decided 2026-08-16: an import-time alt _is_ item 14's alternate, at day level.** Two similar files are two candidate days, and the definitions line up cleanly once the unit is a day—alternates for the same day share their start and end because they share the day's overnight anchors, and diverge in the middle, which is exactly item 14's shape. This settles item 14's open granularity question in favor of day-level; segment-level is not ruled out forever, but day-level is what the schema has to carry first. Two things follow, and the second one is worth more than it looks:

- **The similarity metric is not "are these the same route".** It is "are these two ways of riding the same day", and those want opposite answers in the middle. Real alternates **diverge substantially between their anchors**—that is what makes them alternates—so a whole-path measure like Fréchet or Hausdorff distance would score a genuine over-the-pass / valley-road pair as _dissimilar_ and miss precisely the case this feature exists for. Weight the endpoints: same-ish start, same-ish end, comparable length, divergent middle. Whole-path similarity is the wrong instrument here and would fail quietly.
- **This puts a spectrum where the item first assumed two buckets.** Byte-identical is a mistake to drop; near-identical with different geometry is the same ride exported by two tools, also a drop; same anchors with a divergent middle is an alternate to link; different anchors is two different days. That is three thresholds, not one, and each wants its own prompt and its own default. Getting the middle two the wrong way round is the failure mode—offering to _delete_ someone's alternate route is much worse than offering to link two duplicates.

**Open questions.**

- **Does item 14's alternate object have to wait for item 14? Answered 2026-08-16: no—it shipped without it.** The object landed on its own: `days.alt_group` / `days.alt_active`, one active per group, enforced by `src/maps/alts.ts`. This item is unblocked and needs no new schema for the link relation. Two things it can rely on: grouping is a payload-carried key re-resolved on every save, so the importer sets it the same way the builder does and stores no id of its own; and a group of one is dissolved rather than rejected, so a manifest that links two files and then drops one is a legal payload rather than a validation error.
**Decided 2026-08-16: both hashes, and two different prompts.** A byte hash answers "you dropped this same file twice"; a hash of normalized parsed geometry answers "this is the same route exported by a different tool". They are two different rider mistakes and deserve two different sentences—a single generic "duplicate found" makes the rider work out which one happened. The byte hash also earns its place as a cheap pre-filter, since it needs no parse and settles the common case before the expensive path runs. Note the geometry hash strictly subsumes the byte hash, so this is a messaging and performance decision rather than a coverage one, and the two must never both fire on the same pair.
- **Where the ride-name field goes for a single-file import**, where there is no table to head.
- **How the export half survives this. Answered 2026-08-16: it does not—it is being replaced too, as item 23.** `/import` already is Import / Export (`import.tsx` renders both under one `<h1>`, though `main-menu.md` carried it as a pending decision long after it shipped), and the export half is now getting its own redesign around search and a cart. So both halves of this page are being redrawn at once and **should be drawn together**, not in sequence. Item 23 also depends on this item's review table for the multi-ride zip to be safe to re-import—see the zip-contract note there. Item 22 widens the page they both sit in and comes first.

**Touches.** `src/routes/import.tsx`, `public/js/import.js`, `src/routes/maps.ts` (`POST /api/maps` splits), `src/maps/filename.ts` (the invariant comment, and a new gleaner module beside it), `src/maps/ride-graph.ts` (`insertRideGraph` takes a manifest), `src/db/schema.ts` (staging only—the alternates link relation already exists as of 2026-08-16), `style/` (a new table pattern), `docs/api.md` (the endpoint split and where validation moved), `docs/main-menu.md`.

**Status.** planned—raised 2026-08-16. Sits downstream of item 9, which finished the _formats_; this is the interface none of that work ever got. Blocked on nothing, but the alts question above should be answered before it starts. **Issue: [#129](https://github.com/feralcreative/routeloop/issues/129)**, filed 2026-08-24.

### 22. Content width on `/prefs` and `/import`

**Goal.** Both pages run in a single narrow column on a desktop viewport that has room for two. Widen the content and let fields sit side by side where they belong, rather than stacking everything vertically down a 560px strip.

**Measured 2026-08-16.** The page allows far more than these pages take:

- `.page-wrap` caps at **960px** with `2rem` padding, so **896px** of content is available (`style/_chrome.scss:14`).
- `.setting` caps at **60ch** (`_account.scss:9`), and `.profile-form`, `.import-form` and `.export-list` all cap at **560px** (`_forms.scss:9`, `:39`, `:440`).
- So the effective width on both pages is about **560px**, and the 960px the container offers is never reached. Roughly 340px of usable desktop width goes unused on every visit.

**The distinction that governs the fix, and the way to get this wrong.** The `60ch` and the `44rem` at `_chrome.scss:362` are **measure** caps—they exist so a line of prose does not run to 120 characters, and they are correct. The `560px` on a form is a **layout** cap, and it is the one that is wrong. The tempting fix is to raise 60ch to 90ch and call it done; that widens the prose too and makes the page harder to read while making it look wider. **Separate the two constraints instead:** prose keeps a measure of roughly 60–75ch wherever it appears, and the field grid gets its own, wider track that is free to go two-up. A section can hold both—a paragraph at measure above a two-column grid at full width—and that is the shape to aim for.

**Item 16's governing rule applies here too:** nothing changes size as its value changes. Two columns that collapse at a breakpoint are fine. Columns that appear or vanish depending on how long the content is are the jumping-layout failure item 16 spent a day removing from the builder panel, and it should not be reintroduced on a settings page.

**Work.**

- [ ] Split measure from layout width in `_account.scss` and `_forms.scss`, so a cap on prose stops capping the controls under it.
- [ ] A two-up field grid for `/prefs`, collapsing to one column at the existing `575px` breakpoint (`_account.scss:174`).
- [ ] Decide per group whether it pairs. **Item 20's two new radio groups—Theme and Appearance—are the obvious pair** and are the reason this is worth doing now. The duration format is the counter-example: each of its rows carries a worked example that _is_ the content, so it probably wants the full width rather than half of it.
- [ ] Widen `/import`'s two halves. Note both are being redrawn—the import half as item 21, the export half as item 23—so this is width for a search box, a cart and a manifest table, not for the controls standing there today.
- [ ] Re-measure afterwards. Item 16 is the precedent: a number is the only thing that can say whether a layout pass did anything.

**This is a prerequisite for item 21, not a parallel nicety.** The import review table—ride name, per-row title, per-row date, a drag handle, a drop control and a duplicate flag—**cannot exist inside a 560px form**. Either this lands first or item 21 does it as its opening move; what must not happen is item 21 drawing a table to fit a width that was already known to be wrong.

**Open questions.**

- **Does `.page-wrap`'s 960px itself have to rise, and if so, everywhere or per page?** 896px of content may still be tight for the manifest table once it has six columns and a drag handle. Raising the global cap changes every chrome page including the prose ones, which is a bigger and less obviously good change than widening two pages; a per-page opt-out is narrower but is the kind of exception that multiplies. Decide it against the drawn table, not in advance.
- **Which groups actually pair.** The list above is a starting guess from reading the markup, not a design. It wants one drawn pass over both pages before any of it is built.

**Touches.** `style/_account.scss`, `style/_forms.scss`, `style/_chrome.scss` (only if the global cap moves), `src/routes/prefs.tsx` and `src/routes/import.tsx` (markup regrouped into a grid).

**Status.** planned—raised 2026-08-16, alongside the Settings → Preferences rename recorded in `docs/main-menu.md`. Small on its own, and worth doing before items 20 and 21 rather than after. **Issue: [#130](https://github.com/feralcreative/routeloop/issues/130)**, filed 2026-08-24.

### 23. Export by search and cart, not by list

**Goal.** Replace the export half of `/import` with a search box, a cart, and one zip. A rider searches their rides by name or date, adds the ones they want, picks a format per ride—mixing freely—and hits one button to get a zip of the lot.

**What is there now, and why it stops working.** `import.tsx` selects **every ride the owner has**, unpaginated and unbounded, and renders one row per ride carrying a button per format. The DOM is rides × formats. At a dozen rides it is a wall; at a hundred it is a page nobody can use and a query nobody should run. There is also no way to take two rides at once—each button is a separate download—which is the actual job a rider has when they are loading a device before a trip.

**The interaction to copy is the builder's, not Google's.** "Realtime like the addresses on the map" means the **shape** of `#search-results` in `public/js/builder.js`—debounced input, a list under the field, keyboard-navigable, no submit—**not** its data source, which is Google Places and has nothing to do with rides. Two of that control's hard-won details carry over: it is `position: fixed` so it can escape a scrolling container, and item 16 lists it among the variable-length readouts that reflow whatever sits below them. A results list that pushes the cart down the page as a rider types is the jumping layout item 16 spent a day removing.

**Work.**

- [ ] An owner-scoped ride search endpoint. Name and date, debounced, returning a short capped list. **"By date" means the days' dates, not `rides.createdAt`**—a rider searching "August" means when they rode, not when they made the record.
- [ ] The results list, on the builder's pattern, with the space it occupies reserved rather than pushed.
- [ ] A cart: add, remove, and a per-row format picker. A ride can appear more than once in different formats; the naming convention keeps those files distinct by extension so nothing collides inside the zip.
- [ ] One export button producing one zip, named for the export rather than for any ride in it.
- [ ] **Caps on the way out, mirroring the ones on the way in.** `maps.ts` already refuses a zip with too many files, an oversize member, or too large an unpacked total. `buildZip` returns a `Buffer`, so N rides × M formats is assembled in memory—the cart needs a ceiling, and it should be the same numbers the importer enforces rather than a second set invented here.
- [ ] Retire the every-ride query and the per-ride button row.

**The zip contract is the thing that will break, and it is not obvious.** A zip today means **one ride, one file per day**. `src/routes/maps.ts:180` says so directly—the per-day zip download and the zip import are two halves of one feature—and a dropped zip is expanded before anything asks what format its members are, then handed to `planImport`, which makes those files **the days of a single ride**. So a multi-ride export zip, re-imported, silently becomes one ride with every ride's days glued together in a row. That is a data-loss bug that looks like a successful import.

**The fix is already sitting in the naming convention.** Every file this app writes carries the ride in its name, and `planImport` **already** computes `rideConflict` when conforming files disagree about which ride they belong to—it just currently treats that disagreement as a problem rather than as a boundary. Teach it to read the ride field as a **split point** and a multi-ride zip becomes several rides, correctly, with no manifest file and no directory convention to invent. **Item 21's review table is where a rider would confirm that split**, which makes these two items considerably more valuable together than apart: 21 gives the rider a place to see "this zip holds 3 rides, 9 days" before anything is written, and 23 is what produces such a zip in the first place.

**Open questions.**

**Decided 2026-08-16: the cart always regenerates, including for imported rides.** A cart row means "this ride as it stands now, in this format", and that has to be true of every row or the same button does two different things for reasons a rider cannot see. It is also the only answer that stays correct once a rider edits an imported ride, which they can. **This deliberately diverges from the ride page**, where item 3 established that an imported ride streams its stored original byte-for-byte—that behavior stays where it is and is not being removed, but it does not follow the ride into the cart. Worth a line of copy somewhere near the export button, because a rider who imported a file and exported it straight back will get bytes that differ from what they brought in.

**Decided 2026-08-16: the cart lives in `sessionStorage`.** It survives a reload and a stray back-navigation, and clears when the tab closes. No schema, no cleanup job, no sync path. The job this serves—assembling a device load before a trip—gets interrupted constantly, so losing a ten-ride cart to a misclick is how a rider learns not to use the feature; but a cart that outlives the tab is a stale-state problem for a list that usually lives about ninety seconds. Note this is a **third** client-side storage key alongside the builder draft and the map type, all of which are covered by the strictly-necessary reasoning in `privacy.html`—if that ever stops being true, this is one of the things that made it untrue.
- **Whether search should reach shared rides**, or only owned ones. The current query is owner-scoped and this item keeps that by default; anything wider is a new authorization surface and should be decided deliberately rather than fallen into.

**Touches.** `src/routes/import.tsx` (the export half, replaced), a new search endpoint under `src/routes/`, `public/js/import.js`, `src/maps/zip.ts` (`buildZip` is already there), `src/maps/filename.ts` and `src/routes/maps.ts` (reading the ride field as a split point), `style/_forms.scss` (`.export-list` and `.export-row` go away), `docs/api.md`.

**Status.** planned—raised 2026-08-16. **Shares a page with item 21 and should be drawn with it**, not after it: that page is one `<h1>` over two halves, and redesigning them separately is how they end up looking like two features that happen to share a URL. Item 22's width work is a prerequisite for both. **Issue: [#131](https://github.com/feralcreative/routeloop/issues/131)**, filed 2026-08-24.

### 24. Turn Turnstile on

**Goal.** Activate the bot gate that is already written. `src/maps/turnstile.ts` implements siteverify and fails closed; `POST /api/maps` and `POST /api/rides` both call it; `/import` already renders the widget and loads the script. All of it is dark because `TURNSTILE_SECRET_KEY` is unset, which is the documented flag—"until the widget exists in the Cloudflare dash, dev and prod both run open."

**Setting the two keys today would break "Plan a ride". Fix this first.** `builder.ts` gates `POST /api/rides` on an `X-Turnstile-Token` header, and **nothing sends it**: the builder's two `fetch` calls set `Content-Type` and nothing else, and `TURNSTILE_SITE_KEY` is referenced only in `import.tsx`, so the builder page has no widget and no way to obtain a token. The moment the secret is set, every new ride 403s with "bot check failed—reload and try again", which is a lie—reloading cannot help. The import half would work correctly; ride creation would be dead.

Two ways out, and the second is probably right:

1. **Render a widget on the builder and send the token on create.** Ride creation is a one-shot action, so a single token fits—no expiry or single-use churn, which is the trap if anyone later moves this gate onto the autosave `PUT`. Costs a visible widget on a page that currently has none.
2. **Drop the gate from `POST /api/rides` and keep it on `POST /api/maps`.** Ride creation already sits behind `requireActiveApi` and `requireSameOrigin`, so it takes an approved account and a same-origin request—a bot that has both is not stopped by a checkbox. The import pipeline is the one worth defending: it parses untrusted files, writes storage against a quota, and is where cost actually lands.

**Work.**

- [ ] Create the widget in the Cloudflare dashboard and record its mode. Add `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` to `.env`, and to the deploy environment—both, or the flag is half-on.
- [ ] Resolve the builder gate per the above **before** the secret is set anywhere real.
- [ ] Verify the failure path deliberately: `verifyTurnstile` fails closed, so an unreachable Cloudflare rejects the upload rather than waving it through. Confirm that surfaces as a readable error rather than a silent failure.
- [ ] **Re-check the privacy page.** `privacy.html` currently states "no third-party cookie" and lists the cookie set exhaustively. Turnstile loads `challenges.cloudflare.com/turnstile/v0/api.js`, and whether it stores anything on the visitor's device was untestable locally precisely because the flag is off. Measure it once the widget is live—the same devtools pass that found the page already undercounts its own cookies at three when there are four.

**Touches.** `.env` and the deploy environment, `src/routes/builder.ts` (the gate), `public/js/builder.js` and `src/routes/builder.ts`'s page markup (only under option 1), `src/content/privacy.html`, `docs/api.md`.

**Status.** planned—raised 2026-08-16, when the question "does Turnstile set a cookie" turned up a fully-built feature nobody had switched on. Blocked on nothing except the builder decision above. **Issue: [#132](https://github.com/feralcreative/routeloop/issues/132)**, filed 2026-08-24.

### 25. Noob Mode

**Goal.** Replace the browser's native tooltips with larger, faster ones that actually explain the app. **On by default for everyone, off when the rider says so, and never off on its own.** The native tooltip's text becomes the tooltip's **headline**; under it goes a sentence or two saying what the thing is and why a rider would touch it. The effect should be a guided first pass through the app rather than a help page nobody opens.

**The surface is 32 strings, and that is the good news.** Measured 2026-08-16: 19 `title` attributes in `public/js/` and 13 in `src/`. Fifteen of the nineteen are in `builder.js`, so the builder is very nearly the whole feature.

**But `title` is doing two different jobs here, and only one of them is a tooltip.** Some are **labels for controls**—"Add a day", "Reverse this day—re-routes every leg", "Drag to reorder, or focus and use the arrow keys", "What a map click adds". Those are exactly what this feature is for. The rest are **overflow for dynamic content**—`title="${esc(t.note)}"` shows a stop's note, and the day-label, role and twistiness titles all show data. Those must be left alone: a rider hovering a truncated note wants the note, not a paragraph explaining what notes are. **Filter to the static, authored ones before counting the work**; the real corpus is closer to twenty.

**Storage has a trap in it, even now that the rule is simply "on until switched off".** `user_profiles.duration_format` is the precedent for a single-column preference with its own POST, defaulted rather than nullable so no reader has to interpret a null. Copying that shape lands wrong in one specific way: **a rider may have no `user_profiles` row at all**—which is why `/settings/duration-format` upserts rather than updates—and a rider with no row is precisely the noob this feature exists for. A `.default(true)` cannot help someone who has no row to hold it. So the resolve is "explicit stored value if there is one, otherwise **on**", written as a helper the way `toDurationFormat()` is, rather than left to the column default and assumed.

**Work.**

- [ ] One source of truth for tooltip text. Move the authored strings into a module keyed by control, holding `{ headline, body }`, and have a single tooltip layer render either a native `title` (mode off) or the rich tooltip (mode on). **Do not leave `title` in the markup alongside a custom tooltip**—both will show, and the native one will show late and underneath.
- [ ] The tooltip layer itself: `position: fixed` so it escapes the builder panel's scroll, the same reason `#search-results` is fixed. It is an overlay, so item 16's rule that nothing changes size as its value changes is satisfied by construction—but only if it never pushes layout.
- [ ] Write the twenty explanations. This is the bulk of the work and it is a **copy** job, not an engineering one—`docs/ops/language-style-guide.md` governs, and holding them in one module rather than scattered through markup is what lets them be read and edited as a body of text.
- [ ] The `/prefs` switch, and a resolve helper that answers **on** for a rider with no profile row rather than trusting the column default.
- [ ] **Accessibility, which is where a custom tooltip usually goes wrong.** A native `title` is announced by assistive tech for free; a `<div>` is not. Wire `aria-describedby` from the control to the tooltip, and meet WCAG 1.4.13: dismissible with Escape, hoverable so a pointer can move into it without it vanishing, and persistent rather than on a timer.
- [ ] **"Faster" needs to mean a shorter intent delay, not zero.** Native `title` waits about a second, which is genuinely too slow. Zero produces tooltips strobing across the screen as the pointer crosses a toolbar—and the builder's action row is a line of adjacent icon buttons, which is the worst case for it. Pick a delay, then reduce it while dragging the pointer along that row.

**Decided 2026-08-16: nothing turns it off but the rider.** No expiry window, no ride count, no derived default from account age. The original shape was "on for a TBD time after signup", and dropping the timer removes the timestamp dependency, the resolve-time arithmetic, and the hand-off moment where a rider who had come to rely on the tooltips would find them gone. Time was a weak proxy anyway—a rider who plans one ride and returns three months later is still new on day 91—and rides-created, the better proxy, still needs a threshold nobody can defend. "On until you say otherwise" is both the simplest to build and the hardest to be wrong about. The consequence to keep in view: **experienced riders now meet this feature too**, so the switch has to be easy to find and the tooltips must not be irritating to anyone who has not yet found it. That raises the bar on the delay behavior below rather than lowering it.

**Decided 2026-08-16: desktop first, phones explicitly deferred.** Native `title` never fires on touch, so there are no tooltips on a phone today and this would be net-new interaction design—long-press, or an info target on every labeled control—on the layout with the least room for one. It is a separate problem and it overlaps item 15's on-the-road interface. Deferred, not dropped: the copy module this builds is exactly what a phone treatment would consume later, so nothing here needs redoing.

**Touches.** `src/db/schema.ts` and a migration, `src/routes/prefs.tsx`, a new tooltip-copy module plus a client tooltip layer in `public/js/`, `public/js/builder.js` and `public/js/viewer.js` (where 19 of the 32 titles live), `src/views/layout.tsx`, `style/`, `docs/ops/copy-inventory.md`.

**Status.** planned—raised 2026-08-16, and placed in **phase 2 of the road to beta** the same day: it ships with import/export, before testers arrive, because the least technical end of the cohort is who it exists for. Note `/prefs` is accumulating: the duration format shipped, item 20 adds two radio groups, and this adds a switch. Item 22's width and grouping pass should be drawn against all four rather than against what is on the page today. **Issue: [#133](https://github.com/feralcreative/routeloop/issues/133)**, filed 2026-08-24.

### 26. Rider feedback: reports, ideas and the public board

**Goal.** Give a beta tester somewhere to say "this broke just now" and "I wish it did this", and give the owner a queue to triage it. Phase 3 of the road to beta, and the thing that closes the loop from testers to a release candidate.

**The detail lives in [`docs/rider-feedback.md`](rider-feedback.md)**, a 437-line design written 2026-08-15. It sat in git-ignored `_PLANS/` until 2026-08-16 and was promoted into `docs/` that day—it is a specification rather than working scratch, and one copy on one machine was the wrong home for it. It carries phased commits, marked decision gates and four open calls of its own.

What that plan settles, in brief, so this entry stands alone if the file is ever lost:

- **Build rather than buy.** Featurebase and Fider were evaluated and rejected—SSO priced at $59/seat/mo, single boards, site-wide moderation toggles, and a rider bounced to a subdomain that is not this app. The app already has Google auth, sessions, an owner email, a mailer, storage and an admin surface, so a signed-in rider submits in one tap with no second account. That is the argument.
- **The audience shapes every screen.** Riders on phones, often outdoors, who do not know what a console is and will not write reproduction steps. The intake reads like a person asking what happened and infers the rest.
- **Vocabulary, chosen to stay clear of `ride > day > leg > stop/POI`.** A **report** (`bug`, `idea` or `question`) has a moderation **state** and a rider-facing **status**; a **want** is a vote, and the button says "I want this". The **board** is public at `/board`, the **queue** is the owner's at `/admin/feedback`.
- **It follows the house rule-from-query split**—`feedback/policy.ts` for pure logic that Vitest can drive with no Postgres, `feedback/service.ts` for anything touching the database—matching `invites/`, `survey/` and `stats/`.

**Work.** Follow [`docs/rider-feedback.md`](rider-feedback.md); it carries phased steps and marked decision gates. Do not restate them here—two copies of a 437-line spec will drift. **Four open calls sit at the end of that document and are explicitly not for an implementing agent to decide:** where the entry point goes, how to read map state without touching the `map-common.js` boundary, bright-sun handling, and whether the public board ships now or waits until a request has arrived five or more times.

**Touches.** `src/db/schema.ts` and a migration, a new `src/feedback/`, new routes for `/board` and `/admin/feedback`, the mailer, `docs/api.md`.

**Status.** **shipped 2026-08-17** on `feat/rider-feedback`, merged as [#108](https://github.com/feralcreative/routeloop/pull/108). `src/feedback/` is six modules on the house rule-from-query split—`policy.ts`, `service.ts`, `notify.ts`, `storage.ts`, `diagnostics.ts`, `faq.ts`—with `visibleTo()` in `policy.ts` as the whole of the private-bug rule and `state` versus `status` as two columns for that reason. Tests: `test/feedback-policy.test.ts`, `test/feedback-buffer.test.ts`, `test/feedback-diagnostics.test.ts`, `test/feedback-faq.test.ts`, `test/feedback-status-labels.test.ts`. **Issue: [#115](https://github.com/feralcreative/routeloop/issues/115)**, filed retroactively and closed on 2026-08-24.

**Phase 3 of the road to beta is therefore done, and this entry read "planned" for a week after it shipped**—recorded rather than quietly corrected, because it is the failure mode this file warns about at the top: a document that disagrees with the code loses, and nobody noticed until the roadmap was audited on 2026-08-24. What is owed is a browser pass, and two things that are not code.

**No email has ever actually been delivered.** Local has no SMTP, so every send logs "skipped: mail is not configured" and returns. The call paths are wired and do not break the flows they hang off, but nothing has confirmed a message arrives. **And the flow has only been driven in a desktop browser**, when its entire audience is riders on phones—mobile file inputs and the iOS keyboard shoving the submit button off-screen only surface on hardware. Both want doing before a tester sees the app.

**The four open calls at the end of `docs/rider-feedback.md` were all answered on 2026-08-16**, plus a fifth on automatic screenshots: `getDisplayMedia()` would capture the map correctly where a DOM-capture library cannot, but it is unsupported on every mobile browser, so a file input is the whole answer. That document is a record of a built feature now, not a plan.

### 27. Compress stored originals at rest

**Goal.** Stop spending a rider's quota on uncompressed XML. An imported GPX is the most compressible thing this app stores, and today it sits on disk exactly as it arrived.

**The numbers are measured, not estimated**, taken from `storage/` and the dev database on 2026-08-16.

| What | Today | Compressed | Ratio |
| --- | --- | --- | --- |
| One real 8-day GPX import (`storage/2/50-6.gpx`) | 834,594 B | 115,046 B gzip -9 | **7.3x** |
| The same file, brotli q11 | 834,594 B | 59,895 B | 13.9x |
| All 20 dev rides, `sum(rides.size_bytes)` | 5,826 kB | ~810 kB gzip | **7.2x** |

**The database is already handled and is not part of this item.** `route_legs.geometry` holds 122,647 points across 134 legs. Its raw jsonb text is 2,966 kB; `pg_column_size` reports 1,162 kB actually stored, so **Postgres TOAST already compresses it 2.55x for free**. Encoding it as a polyline instead would win maybe 2x more while touching every renderer, every export and every test that reads a leg, and would make the column unqueryable. Not worth it, and worth writing down so it is not re-proposed.

**Quota keeps counting uncompressed bytes, and the default rises to 100 MB.** Decided 2026-08-16. The alternative—charging compressed bytes for a ~7x effective quota—was rejected because it makes the number unexplainable: two similar rides charge differently depending on how well their XML happens to compress, and a rider who imports something already compressed gets no benefit and no way to understand why. Keeping `size_bytes` meaning "how big is your GPX" keeps the FAQ answerable, and compression pays for the higher ceiling instead—100 MB of gzipped originals costs about what 25 MB of raw ones costs today. So `users.quota_bytes` moves from `26214400` to `104857600` and nothing about the byte columns changes.

**gzip, not brotli, and the reason is the download path.** `src/maps/downloads.ts` streams an imported ride's stored original byte-for-byte for the format it arrived in—that is the hot path, not an archive path. Storing gzip means the file on disk is already the wire format: serve it with `Content-Encoding: gzip` to any client that accepts it and the common request gets *cheaper* than today, with no decompression at all. Brotli is twice as good at rest but riders in this app download straight to Garmins and phone apps, and `Content-Encoding: br` on an attachment is a bet on every one of those clients. Take the 7x.

**Work.**

- [ ] Raise `users.quota_bytes` default to 104857600 in `src/db/schema.ts`, with a generated migration that also lifts existing rows still on the old default. Leave a rider who has been granted a custom quota alone.
- [ ] Compress in `writeMapFile()` (`src/maps/storage.ts`), so there is one place that knows files are stored gzipped. The byte columns are written by `src/routes/maps.ts` from the uncompressed buffer and do not change.
- [ ] Decompress in the read paths: the two download handlers in `src/index.tsx` and the archive loop in `src/account/export.ts:133`. Prefer passing the gzip through with `Content-Encoding` where the request allows it.
- [ ] Extend `STORED_EXTS` or the naming rule to mark a file compressed. **Both files must be readable during the migration**, so the reader has to try one and fall back—this is the fiddly part, not the compression.
- [ ] A `utils/` script to compress what is already on disk, idempotent and safe to re-run.
- [ ] Confirm the account export zip still round-trips: `buildZip` is being handed bytes that were gzip on disk, and the entry must be the plain original.

**Touches.** `src/maps/storage.ts`, `src/index.tsx`, `src/account/export.ts`, `src/db/schema.ts` and a migration, a new `utils/` script. Not `src/maps/downloads.ts`—that table describes formats, not encodings.

**Status.** planned—**folded into phase 2, the Import/Export sprint**, decided 2026-08-16. It opens the same three files that sprint opens anyway, and retrofitting it later means re-opening them plus migrating a larger `storage/` than the 5.8 MB it is now. Not urgent on its own: nobody has come near the quota. **Issue: [#134](https://github.com/feralcreative/routeloop/issues/134)**, filed 2026-08-24.

### 28. Route thumbnails: a preview image per ride

**Goal.** Give every ride a small picture of itself, fitted as tightly to the route as it can be while still showing all of it. It replaces the color swatch in `src/views/cards.tsx:17`, and it is what makes a list of rides scannable rather than a list of titles.

**A Google Static Maps image, not a drawn shape.** Both were considered on 2026-08-16 and a shape-only SVG rendered from `route_legs.geometry` was prototyped against the dev corpus first—it works, costs nothing and themes for free (Bodega Bay: 8,473 points simplified to 329, 3.9 KB). **It was rejected on the design call that a bare squiggle falls flat**, and the pricing below is why that call is affordable. The prototype numbers are kept here because they are the fallback if the cost picture ever changes, and because the simplification they demonstrate is needed either way—see the URL limit below.

**There is no save event and no close event, and this is the fact the whole design turns on.** `public/js/builder.js:331`: "There is no Save button." The builder autosaves on a 3s idle timer with a 20s ceiling, so "regenerate on save" means up to three billable calls a minute for as long as someone is dragging a stop around. "On close" is not an event that exists—`pagehide` is unreliable and misses the ordinary case of navigating away.

**A daily pass over recently-edited rides, gated by a hash of the Static Maps URL.** Two mechanisms, and they do different jobs:

- **The sweep decides when**, and it runs often—every five minutes, over the rides edited since their thumbnail was built **and quiet for at least five minutes**. That second condition is what makes a frequent sweep affordable: an actively-edited ride keeps pushing its own `updated_at` forward and is therefore never selected, so a three-hour editing session produces exactly one call, at the end of it, the same as a thirty-second one. Running out of process also keeps the Google fetch off the render path, which is the reason to prefer this over regenerating lazily when a card is drawn: a fetch inside a page render puts network latency in a ride list and gives a popular stale ride a thundering herd.
- **The hash decides whether it is worth doing at all.** Everything that changes the picture—the encoded polyline, the extent, the day colors, the style—is already in the Static Maps URL, so an identical URL cannot produce a different image. Hash it, store it, and the daily pass skips every ride whose edit did not move the route. Retitling, changing a stop's dwell, flipping visibility and recoloring the legend are all common edits that leave the picture alone.

A day-count trigger was considered and dropped: dragging a route from the coast to the Sierras leaves the day count untouched while changing the picture completely, and the hash catches that case for free.

**The interval is nearly free to shorten, which is why it is five minutes and not a day.** A 24-hour cadence was the first proposal and was dropped on 2026-08-16 once the arithmetic was done: cost tracks the number of *shape changes*, not the number of checks, because a check is a query and a hash while only a changed hash costs a call. Going from 24 hours to 5 minutes therefore does not multiply spend by 288—with the quiet-period condition above it does not multiply it at all, since either way an editing session yields one call. What it buys is a thumbnail that is correct within about five minutes of a rider stopping, rather than the next day.

**The estimate.** 25 riders × 10 editing sessions a month × one call each ≈ **250 calls, or 2.5% of the 10,000 free monthly allowance**. Even an order of magnitude more activity stays inside it. The quiet period, not the sweep interval, is the number to revisit if that ever stops being true.

One consequence worth knowing, and it was stated backwards here until 2026-08-21: **restyling the map does NOT regenerate anything by itself.** A style change does alter every hash, but the sweep selects on `updated_at > thumb_built_at` and only compares hashes among the rows it has already selected—so the hash can prevent work, never cause it. A restyle moves no ride's `updated_at`, so nothing is selected and nothing is rebuilt. `resetThumbnailStamps()` in `src/maps/thumbnail-sweep.ts` is the backfill, reached as `npx tsx utils/sweep-thumbnails.ts --all --until-done`, and it is one `UPDATE` rather than a column because a restyle is rare and deliberate. The hash still earns its keep afterwards: a ride whose picture genuinely did not change costs a query and a hash instead of a Google call.

**Cost, checked against Google's own pricing page 2026-08-16.** Maps Static (SKU `3C2D-B525-2E5F`) is an **Essentials** tier SKU with **10,000 free calls per month**, then $2.00/1000 up to 100k. At beta scale the policy above stays inside the free tier by a wide margin. Note this is a *different* SKU from the `maps-backend` dynamic map loads that carry the 500/day cap, so thumbnails do not eat into the ceiling discussed in "The road to beta"—but they are on the same billing account and want their own alert alongside the one decided there.

**Two traps.**

- **Static Maps is GET-only with an 8192-character URL limit.** Simplify to a fixed **point budget**, not a distance tolerance—a tolerance that suits a day ride will silently blow the limit on a dense 8-day import, and the failure is a 4xx at render time rather than anything visible in testing. ~330 points encodes to roughly 2 KB, which is the measured figure from the prototype and leaves ample headroom.
- **These bytes stay out of `rides.size_bytes` and `users.used_bytes`.** They are derived data, not the rider's file, and charging quota for them would contradict item 27, which raises the quota on the argument that stored bytes mean the rider's own GPX. Follow the precedent in `src/db/schema.ts:786`, where feedback attachments are counted in their own column for exactly this reason.

**Styling: one desaturated map style, not one per theme.** Item 20 brings three themes across light and dark; rendering a variant per combination multiplies calls by six for terrain that is the same terrain. A single neutral style that reads under both schemes is the usual answer, and because a style change costs one URL parameter it is cheap to revisit once the themes exist and it can be judged by eye rather than argued about here.

**Work.**

- [x] `src/maps/thumbnail.ts`—pure: geometry and day colors in, simplified encoded polyline and a Static Maps URL out. It returns the request **without the API key**, which was not in the plan and matters twice: the stored hash survives a key rotation, and no row, log or error message can carry an IP-restricted server key.
- [x] Simplification to a point budget. Douglas-Peucker with the tolerance binary-searched to hit 330 points, since no fixed tolerance maps onto a budget. Worst measured case—8 days × 8,473 points—is **2,927 characters, 36% of the limit**.
- [x] Schema: `thumb_hash` and `thumb_built_at` on `rides`, both nullable, `drizzle/0005_classy_mattie_franklin.sql`. No byte column at all, decided 2026-08-21: the rule that `size_bytes` must name every byte column on that table means a column that has to be excluded from it does not belong on it. The PNG lands at `storage/{ownerId}/{rideId}-thumb.png` and `deleteMapFiles` was extended to sweep it. **Confirmed the autosave `PUT` does bump `updated_at`**—`src/routes/builder.ts:253`, inside the save transaction.
- [x] The sweep, in `src/maps/thumbnail-sweep.ts`. **An in-process interval, decided 2026-08-21**, so this is the app's first scheduler—`src/auth/mailer.ts` and `src/invites/service.ts` both say there is none and should now be read as "there was none". The per-replica caveat is recorded at `startThumbnailSweep()`: at two replicas the hash makes the second pass harmless but the overlap window can double-fetch, and that is when it moves to a cron or an advisory lock.
- [x] Both intervals in one place and named.
- [x] `src/views/cards.tsx`, and `OwnRideRow` in `src/routes/rides.tsx` as well—leaving "Your rides" the only surface without pictures made the feature look half-built, and adding the image to the existing row needs none of the footer-strip restructure item 29 describes.
- [x] Only active days are drawn, and the module calls `activeDays()` from `src/maps/alts.ts` rather than reading `alt_active`. Those are not the same rule: an ungrouped day is active whatever the column says, and the first cut of this had that wrong.

**Touches.** New `src/maps/thumbnail.ts`, `src/views/cards.tsx`, `src/db/schema.ts` and a migration, `style/_chrome.scss` for the card layout, and whatever runs the daily pass. Notably **not** `src/routes/builder.ts`—the autosave path is untouched, which is the point of putting the trigger on `updated_at` rather than in the save handler.

**Status.** **shipped 2026-08-21** on `style/sign-buttons-and-misc`, built out of phase order at Ziad's call. 22 tests in `test/thumbnail.test.ts`; the whole dev corpus renders. **Issue: [#116](https://github.com/feralcreative/routeloop/issues/116)**, filed retroactively and closed on 2026-08-24.

**It needed a Google Cloud change, and that reverses part of item 1.** The Maps Static API was one of the 23 APIs switched off on 2026-08-02, so every call 403'd with "This API is not activated on your API project"—which is a project-level message and not a key one, and worth knowing because the two read almost the same. Enabled on project `tankbag` 2026-08-21, and `static-maps-backend.googleapis.com` added to the server key's API restrictions, which now reads Routes + Geocoding + Static Maps. Item 1's line about "23 of 27 off, leaving only Maps JavaScript, Places (New), Routes and Geocoding" is therefore out of date. Restriction changes take a few minutes to propagate; a 403 straight after the change is not a failure.

**Still owed:** the quota alert this section asks for, alongside the one decided in "The road to beta". Nothing has been set up on the Static Maps SKU.

### 29. Cards instead of rows, wherever rides are listed

**Goal.** A ride in a list should show its route, not just its title. Every browsing list becomes a grid of cards with the item 28 thumbnail as the face of each one. **Stated as a general preference on 2026-08-16**—cards over rows anywhere rides are browsed—rather than as a fix to two named pages.

**It depends on item 28 and is not worth starting before it.** A card without a thumbnail is a row with more padding, and worse: it trades a scannable dense list for a sparse one and gives nothing back. Ship the pictures first.

**The four surfaces, and how they are wired.**

| Surface | Renders via | Notes |
| --- | --- | --- |
| `/` dashboard, "Picking up where you left off" | `rideCards()` | A short recent strip inside a page already carrying tiles, a role chart, an activity graph and a meter. The densest context of the four; check it does not crowd. |
| `/explore` | `rideCards(cards, showViews)` | Also shows a view count. |
| `/@username` public profiles | `rideCards(cards)` | |
| `/rides`, "Your rides" | `OwnRideRow` in `src/routes/rides.tsx:22` | **Deliberately not shared**—it carries a visibility pill and an Edit link the public card must never show. Read the comment above it before merging the two; the separation is the contract. |

Three of the four move together because they are one component. That is a reason to convert them together rather than an obstacle.

**Where this stops, and it matters because "everywhere" invites over-application.** This is about lists a rider *browses*. It is **not** the import review table (item 21), which is an editable manifest with draggable day order and inline fields—a data grid, where cards would actively hurt. It is **not** the export cart (item 23), which is a selection list where compact rows are the right density. Both of those are lists of rides, and neither of them wants this.

**Design calls, decided 2026-08-16.**

- **A fixed aspect box, not one per route.** A route's bounding box is whatever shape the road took—a long north-south ride and an east-west one have nothing in common—so uniform cards mean picking one ratio and letting Static Maps fit the route inside it. Its auto-fit already does that when `center` and `zoom` are omitted, so this costs a `size` parameter and no extra logic. `size=320x200&scale=2` renders 640×400 actual pixels, which is within the 640 cap and sharp on a retina card at roughly 320 CSS pixels.
- **Edit and the visibility pill go in a footer strip inside the card**, pill left, Edit right, below the title and stats. Always visible rather than revealed on hover: hover does not exist on a phone, and a meaningful share of the beta cohort is on one, so a hover-only affordance needs a visible fallback below tablet width and is therefore two implementations to save nothing.
- **The existing color swatch becomes the placeholder**, for a ride whose thumbnail has not been built yet and for one with no geometry to draw—a ride with stops but no legs is a real state, not a hypothetical.

**One trap, and it is invalid HTML rather than a style bug.** Today `<a class="card">` wraps the whole row and `.editlink` is a **sibling** inside the `<li>` (`src/routes/rides.tsx:24-39`). That structure is what keeps Edit out of the card's link. A footer strip drawn *inside* the card link nests an anchor in an anchor, which browsers silently reparent—so the layout breaks in a way that looks like a CSS problem and is not. Keep the footer a sibling of the card link and position it with the grid.

**Work.**

- [ ] `src/views/cards.tsx`—the card gains a thumbnail slot; `.swatch` becomes the fallback. While in the file, note that `rideCards()` returns a string via `.toString()` for callers that still concatenate; converting it is out of scope here but the comment at the top of the file explains the plan.
- [ ] `src/routes/rides.tsx`—`OwnRideRow` gains the same thumbnail plus the footer strip. Stays a separate component.
- [ ] `style/_chrome.scss`—`a.card`, `.swatch`, `.meta`, `.cardrow` and `.editlink` are all built around a flex row and get replaced. A responsive grid on `.cards`, auto-filling on a minimum card width, so one column on a phone falls out of the same rule.
- [ ] Check the dashboard strip specifically. It is the one surface where a grid competes with everything else on the page, and it may want a smaller card or a horizontal scroller rather than the same grid.
- [ ] Lazy-load thumbnails below the fold. A profile or an Explore page is an unbounded list of images now, which it never was before.

**Touches.** `src/views/cards.tsx`, `src/routes/rides.tsx`, `style/_chrome.scss`, and `style/_dashboard.scss` if the dashboard strip diverges. **Interacts with item 22**—a wider content column on desktop is what makes a three- or four-up grid worth having, so the two are better done in either order than half of each.

**Status.** planned—**phase 2, after item 28**, decided 2026-08-16. Blocked on the thumbnails by design rather than by dependency; the code would build without them and should not. **Issue: [#135](https://github.com/feralcreative/routeloop/issues/135)**, filed 2026-08-24.

### 30. Make "Your records" flashier

**Goal.** The records block is the most celebratory thing on the dashboard and currently looks like the least. Four bordered white boxes with a 1.15rem number in each—the same weight the app gives a form label. Quips were considered and dropped on 2026-08-16; this is a visual treatment only, no copy changes and no new data.

**What it is today**, `style/_dashboard.scss:262`: a `repeat(auto-fit, minmax(13rem, 1fr))` grid of `li`, each a white box with a 1px border and 10px radius, holding an uppercase 0.8rem `.record-label`, a 1.15rem/600 `.record-value` and a 0.85rem `.record-hint`. The markup is already right—the problem is entirely that nothing in it is loud.

**The moves, cheapest first.**

- **Scale the number up hard.** 1.15rem is timid for the one figure on the block worth reading. The page already has a precedent in `.hero-value`; records should sit clearly between that and body text rather than beside a label.
- **Split the unit off the number.** "482 mi" reading as one string wastes the emphasis on "mi". Big numeral, small unit, and the same split works for the twist figure.
- **An icon per record.** There are exactly four kinds and they are fixed, so this is four glyphs and no logic. The icon set was already reworked on this branch (`8e5a6e8`), so there is a house style to match rather than invent.
- **Give the box some presence.** A tint or accent edge instead of the flat `$grey` border, and a hover lift. These are achievement cards; they should not be styled like the storage meter.
- **Count-up on load, as the genuinely flashy option.** Cheap—the values are already rendered—and the block is above the fold on a page riders open often. **Gate it on `prefers-reduced-motion`**, and make the final value the rendered one so a rider who blocks scripts sees the number rather than a zero.

**Build it on tokens, not literals, or it gets done twice.** Item 20 brings three themes across light and dark. `_dashboard.scss` currently hard-codes `$white`, `$grey` and `$neutral-57` throughout, which is a pre-existing problem and not this item's to fix—but new tints, accents and shadows added here should come from the theme layer, because anything spelled as a literal color now is work to be redone when item 20 lands.

**Work.**

- [ ] `style/_dashboard.scss`—the `.record-list` treatment: scale, accent, hover.
- [ ] `src/stats/shape.ts`—split value and unit if the type split is wanted in markup rather than in CSS. This is the only reason the item touches anything but styles.
- [ ] `src/routes/home.tsx`—icon slot per record kind.
- [ ] Count-up, behind `prefers-reduced-motion`, degrading to the static number.

**Touches.** `style/_dashboard.scss` mainly, `src/routes/home.tsx` for the icons, `src/stats/shape.ts` only if value and unit get split server-side.

**Status.** planned—small and self-contained, no schema and no queries. A good candidate to slot in beside phase 1 work when a break from the builder is wanted. **Issue: [#136](https://github.com/feralcreative/routeloop/issues/136)**, filed 2026-08-24.

### 31. Three columns on the dashboard tiles: yours, average, top

**Goal.** Each of the four stat tiles at the top of `/` shows the rider's number, the average across all riders, and the highest anyone has. A number alone says nothing about whether it is a lot.

**Scope, decided 2026-08-16.** All four tiles—**rides, days, legs and waypoints**. **Legs is included knowingly**: a leg is an internal artifact, one per pair of consecutive stops, and it is not a unit any rider thinks in. It was put in the list deliberately rather than by omission, so it is not to be quietly dropped as a cleanup.

**The pool is every rider and every ride, private included.** Decided 2026-08-16 after the alternatives were put up: no opt-in preference, no visibility filter, no minimum cohort size. This is a private beta among friends and the columns carry no names.

**The filters are not the same across the four tiles, and this is the trap.** `src/stats/query.ts` scopes `rides` and `points` by `owned` alone, but `days` and `legs` by `counts`, which adds `eq(days.altActive, true)`. The asymmetry is deliberate and reasoned at line 40—a stop a rider planned is work they did, a mile on a day they decided against is not a road they will ride. **The global query has to mirror each tile's predicate exactly.** Getting it wrong is not a visible bug: the page renders, the numbers look plausible, and every rider is silently measured against a bar that counts alternates their own figure excludes.

**Two more things `query.ts` already knows and this must not relearn.**

- **No mega-join.** The file's opening comment explains why there are five queries rather than one: joining rides to days to points *and* legs multiplies rows against each other and produces sums several times too large, in a way that "looks like enthusiasm rather than arithmetic". A per-user rollup CTE feeding an aggregate has exactly the same hazard—one query per metric family, then aggregate the rollups.
- **`cachedUsedBytes()` is not a cache.** It reads the denormalized `users.used_bytes` column. There is no TTL-cache precedent in this app to copy, so this item introduces the first one.

**Cache it, because it is identical for every viewer.** Avg and Top do not vary by who is looking and they move slowly, so one computation serves the whole site. An in-process TTL is enough—this is decoration, staleness costs nothing, and a cold cache costs one query. **Note it is per-replica**, so two replicas do the work twice; that is acceptable here and would not be for anything a rider acts on.

**Three edges worth deciding in code rather than discovering.**

- **The rider is the top.** Their number appears in two columns. Say so rather than letting it read as coincidence.
- **One rider in the pool.** Yours, the average and the top are the same number three times. True in dev today and true on the first day of the beta.
- **A rider with nothing.** The tiles only render under `hasRides`, so this is already handled—but the average and top are still meaningful for them and are the one case where the comparison is most useful.

**Layout is the real work.** Four tiles × three numbers is twelve figures where there were four, above the fold, on a page that continues into a role chart, an activity graph and a meter. The rider's own number must stay dominant—it is the one they came for—with average and top clearly subordinate. On a phone this needs to degrade to something other than a twelve-cell grid.

**Work.**

- [ ] A global-stats query in `src/stats/query.ts`, one per metric family, each reusing the *same* predicate as its per-user counterpart.
- [ ] A test that pins the alternates asymmetry: a losing alternate day must move the global `days` and `legs` averages exactly as it moves the rider's own figures, and must not move `rides` or `points`.
- [ ] TTL cache around it, with the interval named and the per-replica behavior noted where it is defined.
- [ ] Shape it in `src/stats/shape.ts`. **Do not widen `Tile`**—it also backs `records: Tile[]`, and the comparison fields would leak into a block that has no use for them. Give the tiles their own type, or make the fields optional and never set them on records.
- [ ] `src/routes/home.tsx` and `style/_dashboard.scss`—`StatTile` gains the two extra values; the rider's own number keeps visual primacy.

**Touches.** `src/stats/query.ts`, `src/stats/shape.ts`, `src/routes/home.tsx`, `style/_dashboard.scss`. No schema change.

**Status.** planned—not blocked on anything, but the pool decision above is load-bearing and should not be revisited quietly: widening or narrowing it later changes every number on the page. **Issue: [#137](https://github.com/feralcreative/routeloop/issues/137)**, filed 2026-08-24.

### 32. Icons and per-role color on "What you stop for"

**Goal.** The role chart on the dashboard is seventeen identical bars in one hue, distinguished only by their text labels. Give each role its icon and its own color so the block can be read at a glance instead of word by word.

**Most of this is already built.** `src/stats/shape.ts:168` already puts `icon` on every `RoleBar`, taken from `ROLE_META` in `src/maps/roles.ts`, and all seventeen SVGs are on disk at `public/img/icons/`. `RoleChart` in `src/routes/home.tsx:68` simply does not render the field it is handed. This is a view change—no query, no shape change, no new assets.

**The icons are already colorable, by construction.** Each is a disc filled `currentColor` with a white glyph over it, so setting CSS `color` produces a colored badge with a white symbol and nothing needs editing. Verified across the set 2026-08-16.

**But `<img src>` will not work, and this is the trap.** `currentColor` inside an externally-referenced SVG resolves against that document's own context, not the host page's, so an `<img>` renders black regardless of the CSS around it. The icons have to be **inlined into the HTML**. `public/js/map-common.js:664` already solves the same problem client-side by fetching and caching them; the server needs the equivalent—read once, cache at module level, embed. Seventeen file reads per dashboard render is the failure mode to avoid.

**Colors are fixed per role, not random per render.** Decided 2026-08-16. Stable assignment means the eye learns the chart—gas is the same color every visit—and it lets the palette be tuned once for contrast instead of gambling on each roll. "Random" here means unordered, which these categories genuinely are; it does not mean reshuffled.

**A new palette, not `DAY_COLORS`.** `src/maps/palette.ts` holds twelve colors and this needs seventeen, so five roles would wrap onto a duplicate—but the real objection is semantic: the same color would mean "day 3" in a ride legend and "coffee" here, in an app where colored lines already carry meaning. Roles get their own table, beside the day palette and following its conventions: defined server-side, shipped to the client through the page shell the way `ROLE_META` and `DAY_COLORS` already are, so no second copy can drift.

**Rewrite the comment in `RoleChart`, do not just overrule it.** It currently argues that "a ramp across seventeen rows would imply an ordering the categories do not have," and **that reasoning is correct**—it just does not apply here. A sequential ramp implies rank; a categorical palette implies category, which is exactly what a role is. The replacement comment should say why categorical color is right and why a ramp would still be wrong, or the next reader will assume the original point was missed.

**Build the palette for contrast across both schemes.** Seventeen hues at fixed lightness and chroma, evenly spaced, rather than seventeen hand-picked values—the constraint is that each stays legible as a bar fill and as a badge on white today and on a dark surface once item 20 lands. Getting it right once here is cheaper than retuning seventeen literals later.

**Work.**

- [ ] `src/maps/role-colors.ts`—seventeen colors keyed by `Role`, exported like `DAY_COLORS` and injected through the page shell.
- [ ] Server-side inline-SVG helper with a module-level cache, so the icons are read from disk once per process rather than once per render.
- [ ] `src/routes/home.tsx`—`RoleChart` renders the badge and applies the role color to it and to `.role-fill`; the comment gets rewritten as above.
- [ ] `style/_dashboard.scss`—badge sizing in the `.role-bar` grid, which currently has no icon column.
- [ ] A test pinning `ROLES`, `ROLE_META` and the color table to the same seventeen keys. The taxonomy already has to stay in sync with `waypointRoleEnum` and `src/maps/roles.ts`; this adds a fourth list, and the existing sync requirements are documented precisely because they have drifted before.

**Touches.** `src/routes/home.tsx`, `style/_dashboard.scss`, new `src/maps/role-colors.ts`, a small inline-SVG helper in `src/views/`. No schema, no queries, no new assets.

**Status.** planned—small and self-contained. **Issue: [#139](https://github.com/feralcreative/routeloop/issues/139)**, filed 2026-08-24. Related to item 30 ([#136](https://github.com/feralcreative/routeloop/issues/136)), the other "make the dashboard less flat" item; the two touch the same file and are worth doing in one pass.

### 33. Find a stop that does more than one job

**Goal.** Near the end of a tank or a battery, find somewhere to stop that refuels *and* feeds you *and* gives you something to do while you wait. Raised 2026-08-30 by a rider on an electric motorcycle: pick a general area at the tail end of range, then find the stop with the most at your fingertips.

**Fuel-type agnostic, decided 2026-08-30.** It arrived as an EV request and the EV case is the sharper one—a charge is 30–45 minutes of standing still, so "what else is here" is the difference between a break and a wait. But a gas rider has the same problem with a five-minute stop, item 7 already stores range in meters for both, and `fuelTypeEnum` is already `['gas', 'electric']`. The shared machinery is the whole feature; the EV-specific part is two request filters and a longer dwell radius.

**This is already the data model, and that is the happy part.** `points.roles` is a `waypoint_role[]` capped at four by the database, and the taxonomy already contains `gas`, `charge`, `food`, `coffee`, `view`, `grocery` and `break`. **A stop that does more than one job is a point with more than one role**—nothing new to model, and item 32's role chart already draws the payoff.

**The search area costs nothing, because the data is already stored.** `points.dist_from_start_m` is server-computed, `route_legs.geometry` holds the polyline, and item 7 stores range in meters. So "the stretch of route between 75% and 95% of remaining range" is arithmetic on rows already in Postgres—no API call to decide *where* to look. Search that band as a corridor polygon along the route, not a circle around a midpoint: a circle at the range limit includes a large area the rider would have to backtrack to reach.

**Three questions, three different APIs, and they cost wildly different amounts.**

| Question | API | Free/month | Then |
| --- | --- | --- | --- |
| Which area has the most going on? | **Places Aggregate**, `INSIGHT_COUNT` over a polygon | 5,000 | $10/1000 |
| Which specific stops are in it? | **Text Search (New)**, `evOptions` for EV | 10,000 at Essentials | $2.27/1000 |
| What is actually at this one? | `evChargeAmenitySummary` | **1,000** | **$40/1000** |

**Nearby Search cannot filter on EV and Text Search can.** Nearby Search (New) will *return* `evChargeOptions` and `evChargeAmenitySummary` but offers no EV filter—only `includedTypes`—so filtering would mean fetching everything at the Enterprise + Atmosphere rate and discarding most of it. Text Search (New) takes `evOptions` with `connectorTypes` and `minimumChargingRateKw`, which is what keeps a rider off a 3 kW outlet that would take all night. Use Text Search. Verified against Google's docs 2026-08-30.

**The cost rule: cheap calls build the list, the expensive field is fetched only on a tap.** Decided 2026-08-30. `evChargeAmenitySummary` is Enterprise + Atmosphere—**$40/1000 with a 1,000-call free cap**, the most expensive thing this app would touch by a wide margin. Fetching it for five candidates costs about 20¢ per search and exhausts the free tier in roughly 200 searches across all riders. Fetching it for the one candidate a rider opens makes the same allowance cover about a thousand real decisions. Same shape as item 28: never buy the expensive thing until someone looks at it.

**Cache aggressively—chargers and restaurants do not move.** Key by area cell plus filter set, with a long TTL. This is the single largest cost lever in the item and it should be designed in rather than added when a bill arrives.

**The summary is written by Gemini and Google requires you to say so.** The field carries `disclosureText` ("Summarized with Gemini", localized) and `flagContentUri` for reporting bad content. Both have to be rendered. That means AI-written prose appears inside an app whose voice is otherwise deliberate and dry—worth deciding consciously rather than discovering in review. The `overview` subfield is guaranteed; `coffee`, `restaurant` and `store` are not, and each `ContentBlock` also carries references to the related places for follow-up calls.

**Ranking is diversity, not count.** Six fast-food outlets in one lot is a worse stop than one café, one diner and a park, and a naive count ranks it higher. Weight distinct categories over raw quantity. **And check opening hours against the estimated arrival time**, which the ride timeline can already supply—arriving at 9pm to a closed everything is the failure this feature exists to prevent, and it is the one a count-based score will walk straight into.

**Open questions.**

- **Where it lives in the builder.** A panel action on a day, a map affordance at the range ring, or part of the stop search. Interacts with item 6 (saved places) and item 11 (rich stop details).
- **Whether range rings ship first.** Item 7 still lists "fuel/charge range rings" as unbuilt, and this feature is much easier to explain when the rider can already see where their range runs out.
- **Which Places tier the non-EV path uses.** Essentials is cheap and has 10,000 free but carries fewer fields; whether a gas stop needs anything above it is unsettled.

**Touches.** New Places client under `src/maps/`, `src/bikes/policy.ts` (range band arithmetic), `src/routes/builder.ts`, `public/js/builder.js`, a cache table or store. Related: [#31](https://github.com/feralcreative/routeloop/issues/31) EV counterpart, which is the battery-and-consumption half and a prerequisite for the EV range band.

**Status.** planned—raised 2026-08-30. **Not a beta blocker**, and it introduces the first Places spend beyond autocomplete, so it wants the quota alert from "The road to beta" in place first.

## Idea backlog (unscheduled)

Not yet shaped into milestones—raw material for future issues. Grouped by theme.

**Planning power.**

- Elevation and grade profile per day, drawn under the timeline.
- Weather forecast along the route keyed to each leg's date-time—the timeline makes this genuinely useful, not a gimmick.
- [x] Print-friendly roadbook for riders who tape it to the tank—`/m/:slug/roadbook`. **Stop-by-stop, not turn-by-turn:** `route_legs` holds geometry, distance and duration and nothing else, maneuvers are a separate Directions field priced per call, and they would be blank for every imported ride anyway. What it does print is the part that stays true when a road closes: stops in order, leg and cumulative miles, **miles since fuel**, planned dwell, and an estimated clock when the day has a start time.
- [x] Reverse a day; duplicate a ride as a template. **Both shipped** (#26). Reverse is the ⇄ in the builder's day head—`reverseDay()` in `public/js/builder.js` re-requests every leg from the router rather than flipping geometry in place, because a leg's geometry and its shaping points are both directional. Duplicate shipped as "Clone this ride" with item 10.
- Distance and moving-time estimates with configurable rest cadence.

**Motorcycle-specific.**

- Twistiness / curvature scoring, and a "prefer the fun road" routing bias—the feature that would beat MyRouteApp for riders who care about the road, not the ETA.
- Avoid-highways / prefer-scenic routing options.
- Per-leg surface preference (paved / unpaved) and an off-road mode.
- EV charge-stop planning as the electric counterpart to fuel range.

**Social and collaboration.**

- Real-time or turn-based co-editing of a shared ride.
- Trip journal: photos and notes attached to stops.
- Follow other riders; a feed of public rides.

**Data and formats.**

- ~~Round-trip fidelity tests per format, so import→export never silently loses a stop.~~ **Shipped** with item 9 ([#35](https://github.com/feralcreative/routeloop/issues/35))—`test/round-trip.test.ts` against one ride written five ways.
- ~~Bulk import of a folder of files into one ride.~~ **Shipped 2026-08-03** with item 9; several files become several days of one ride.
- PostGIS for spatial queries once discovery needs "rides near me."

**Platform and quality.**

- ~~Autosave and undo in the builder.~~ **Both shipped**—undo 2026-08-05, autosave-to-server 2026-08-15 with item 16, which also deleted the Save and Discard buttons.
- ~~Drag-to-reorder stops ([#39](https://github.com/feralcreative/routeloop/issues/39))—the affordance is decided, a textured drag bar replacing the arrows.~~ **Shipped 2026-08-15** with item 16, on SortableJS with the textured handle as described.
- Keyboard shortcuts for the builder.
- Usage analytics that respect privacy (self-hosted, no third-party trackers).

## Non-goals

Things deliberately not built, recorded so they do not get proposed twice. These are decisions, not backlog—if one changes, change it here rather than opening an issue.

<!-- col-widths: 26% 74% -->

| Not doing                             | Why                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Round-trip generators**             | Scenic, Kurviger and Garmin all ship one and riders say all three pad the distance with junk roads—"many roads that are minor and not fast at all… just there to make up the total distance." Garmin's Adventurous Routing gets called a complete disaster. Shipped everywhere, good nowhere.                                                                          |
| **Turn-by-turn navigation**           | Not a permanent vow, but a separate product with its own failure surface: freezing, battery drain, late voice cues, destructive recalculation. That is where every competitor's reputation actually fails. Nothing should be attempted here until the hand-off is excellent, and a companion app is a different conversation from bolting navigation onto the planner. |
| **Curviness as the headline feature** | Kurviger picks single-track farm lanes because they carry a high speed limit; American riders call the result borderline useless. Curviness without road-width and speed-limit context produces routes nobody wants. Worth having (#28); not worth leading with.                                                                                                       |
| **Inventing new vocabulary**          | Shaping, via, waypoint and stop already mean something different in every tool, and getting it wrong silently ruins a route. Name things the way _devices_ name them, not the way the app thinks about them.                                                                                                                                                           |
| **Paywalling export or sharing**      | A tool that cannot hand a GPX to a friend on another app is useless for group riding. Accountless view links and unrestricted export stay free regardless of what else ever does not.                                                                                                                                                                                  |

One wording correction that falls out of this: the vision above says Routeloop is "not real-time navigation, and never will be." **Never** overstates it. The accurate claim is that it does not navigate today, and that making the app you already use follow your plan is the better problem to solve first.

## Good first contributions

Well-scoped, low-context tasks a new contributor can land without holding the whole app in their head. These carry the _good first issue_ label on GitHub.

- **[#40](https://github.com/feralcreative/routeloop/issues/40) Keyboard shortcuts for the builder.** Contained to `public/js/builder.js` and its key handling.
- **[#51](https://github.com/feralcreative/routeloop/issues/51) Layer stacking with per-layer opacity.** A self-contained map-engine feature with a clear reference implementation in Gaia GPS.

The three tasks previously listed here—privacy and terms pages, the day-slider tick labels, and the `profile.js` geocoding proxy—all shipped, as #18, #19 and #20.

## Working in this repo

Setup, the gotchas that will bite you, branch and commit conventions, and how to open a pull request all live in **[CONTRIBUTING.md](../CONTRIBUTING.md)**. It is the canonical copy—GitHub links it from the issue and pull-request composer, which is why it is there rather than here.

Two things to read first either way: [AGENTS.md](../AGENTS.md) for the operating rules, and [STATUS.md](STATUS.md) for where things actually stand.
