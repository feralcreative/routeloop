# Rider feedback: reports, ideas and the rider board

**Created:** 2026-08-15. **Shipped 2026-08-16** in seven commits on `feat/rider-feedback`—this document is now a record of a built feature rather than a plan, and every open call at the end of it is answered.

**"Public board" was the wrong phrase and appears throughout this document.** `/board` is behind `requireActive` and always was—see the endpoint table, which has said "**Signed-in only**" since this was written. Read "public" here as "visible to every rider", never "anonymous". Confirmed as intended on 2026-08-16.

## Context

There is no way for a rider to tell us anything. The beta is invite-only and hand-approved, every rider arrived through a person, and the only channel back is email to a human who may or may not read it that week. The survey answered "what do you think of the idea"; nothing answers "this broke just now."

Third-party tools were evaluated and rejected. The two that fit the requirements—moderated intake, a public board, upvoting—are Featurebase Free and self-hosted Fider. Featurebase gates real SSO at $59/seat/mo and is a freemium product that can gut its free tier at any time; Fider cannot do custom form fields, runs one board, and its moderation is a single site-wide toggle. Both put riders on a subdomain that is not this app. We already have Google auth, a session, an owner email, a mailer, a storage path and an admin surface, so the marginal cost of building it here is much smaller than it would be for a greenfield product, and the thing we get is ours.

**The audience is the constraint that shapes every screen.** Motorcyclists and drivers, on phones, often outdoors. They do not know what a console is, will not write reproduction steps, and will abandon a form that asks. The intake has to read like a person asking what happened and infer the rest.

## Rules of engagement for this build

Per `AGENTS.md`, which outranks this file:

- **Do not run `npm run db:generate` until Ziad approves the schema.** Schema changes need human approval. Post the proposed `schema.ts` diff, wait, then generate. Read the generated SQL before applying it.
- **Do not add a dependency.** Everything below is achievable with what is in `package.json`. If you believe otherwise, stop and make the case—a new dependency needs human approval.
- **Do not commit, push or deploy.** Hand over a single chained one-liner when a step is done and let Ziad run it.
- **Do not touch `public/js/map-common.js`** without asking. It is the only file that calls `google.maps` and that boundary is Ziad's call, not yours. Phase 4 needs a map-state read; the plan routes around it deliberately—see there.
- **Offer options at the marked gates rather than picking.** Each `> **Gate:**` block below is a real choice with more than one defensible answer.

Everything else here is settled and can be implemented straight through.

## Vocabulary

New nouns, chosen to stay clear of `ride > day > leg > stop/POI` and of the ~130 `*Routes` identifiers that mean HTTP handlers:

- A **report** is one submission of any kind. The table is `feedback`; a row is a report. Never "ticket", never "issue" (that word belongs to GitHub), never "post".
- Its **kind** is `bug`, `idea` or `question`.
- Its **state** is the owner's gate: `pending`, `published`, `declined`, `duplicate`, `spam`.
- Its **status** is the rider-facing lifecycle, and it is what the labels in the copy section render.
- A **want** is a vote. The button says "I want this", never "upvote", and the count reads "38 riders want this."
- The **board** is the public page at `/board`. The **queue** is the owner's moderation page at `/admin/feedback`.

## What the codebase already gives us

Verified by reading, not assumed. These are the facts the design leans on.

**Identity is free and this is the whole reason to build rather than buy.** `withSession` resolves the session for every request after the static assets, and `currentUser(c)` returns a `UserRow`. A signed-in rider submits with one tap and no second account. That is the requirement no hosted tool met under $10/mo.

**The gates already exist.** `requireActive` for rider surfaces, `requireManageRiders` for the queue, `requireSameOrigin` on every write, `requireActiveApi` for anything a `fetch()` calls. Do not invent new middleware.

**The rule-from-query split is the house pattern for testability.** `invites/policy.ts` vs `service.ts`, `survey/score.ts` vs `questions.ts`, `stats/shape.ts` vs `query.ts`. `vitest.config.ts` is deliberately scoped to pure logic and CI runs with no Postgres, so anything that needs a test goes in `feedback/policy.ts` and anything that touches the database goes in `feedback/service.ts`.

**Emails are a typed registry and everything in `src/emails/` must be pure.** `defineEmail` infers props from `sample`, `ALL_EMAILS` is what `test/emails.test.ts` iterates, and a template without a `sample` does not compile. Anything that reads a table lives outside that directory—`src/auth/notify.ts` is the precedent.

**Storage is on disk, not S3.** `STORAGE_PATH`, `src/maps/storage.ts`, `moto-storage/`. Attachments follow that convention, which is also how this build avoids a new dependency.

> **`rides.size_bytes` is a generated column over `kml_bytes + gpx_bytes + source_bytes` and `users.used_bytes` is incremented on import and decremented from `size_bytes` on delete.** Feedback attachments must stay out of both. They are not ride data, they must not consume a rider's 25 MB, and adding a fourth byte column to that generated expression would corrupt quota accounting on every ride delete. Count attachment bytes in `feedback_attachments.bytes` and cap them separately.

**`OWNER_EMAIL` already exists** in `src/config.ts`, defaulting to Ziad's address. New-report notification uses it. No new env var is needed for the MVP.

## The state model

Two orthogonal columns, and collapsing them into one enum is the mistake to avoid.

`state` is the owner's gate and controls visibility. Nothing is public until it is `published`:

```
pending ─┬─> published    (visible on /board; wants open if kind = 'idea')
         ├─> declined     (author-visible only, with a reason)
         ├─> duplicate    (author-visible, links to the original)
         └─> spam         (author-visible, silent)
```

`status` is the rider-facing lifecycle and is independent of the gate—a bug can be `fixed` while still `pending`, which is the normal case for a bug nobody else needs to see.

| kind | default `state` | typical end `state` | wants |
|---|---|---|---|
| `bug` | `pending` | stays `pending`—publishing a bug is the exception, for a known-issue banner that cuts duplicate reports | off in Phase 1; "this happened to me too" is a Phase 5 option |
| `idea` | `pending` | `published` or `declined` | on once published |
| `question` | `pending` | answered by email, rarely published | off |

This is what satisfies both requirements with one mechanism: **an unpublished report is private to its author and the owner, so bugs are private by default because nothing publishes them.** There is no separate private-bug feature to build.

`priority` is a `smallint`, owner-only, and **never rendered on a rider-facing surface**. A rider seeing "your bug is P3" is a support incident.

## Schema

Add to `src/db/schema.ts`. Match the file's existing style: a comment block above each table explaining how it ended up that way, `bigserial` ids, `bigint({ mode: 'number' })` foreign keys, explicit indexes in the third argument.

```ts
export const feedbackKindEnum = pgEnum('feedback_kind', ['bug', 'idea', 'question'])
export const feedbackStateEnum = pgEnum('feedback_state', [
  'pending', 'published', 'declined', 'duplicate', 'spam',
])
export const feedbackStatusEnum = pgEnum('feedback_status', [
  'new', 'needs_info', 'confirmed', 'planned', 'in_progress', 'shipped',
  'on_list', 'not_doing', 'no_repro', 'by_design',
])
```

`feedback`

| column | type | notes |
|---|---|---|
| `id` | `bigserial` pk | |
| `publicId` | `varchar(22)` unique | unguessable, same generator as `rides.slug`. The board and the rider's own view address a report by this, never by `id` |
| `authorId` | `bigint` → `users.id` `onDelete: 'cascade'` | GTFO deletes a rider's reports with them |
| `kind` | `feedbackKindEnum` notNull | |
| `state` | `feedbackStateEnum` notNull default `'pending'` | |
| `status` | `feedbackStatusEnum` notNull default `'new'` | |
| `title` | `varchar(150)` | nullable—derived from the first line of `body` at submit time, editable by the owner before publishing. Riders are not asked for a title |
| `body` | `varchar(4000)` notNull | the one required field |
| `context` | `varchar(2000)` | the "when did you last wish you had it" answer, ideas only |
| `area` | `varchar(40)` | which screen, from the chip group. Nullable—inferred from the referring path when it can be |
| `frequency` | `varchar(20)` | `every_time` / `sometimes` / `once` / `unknown`. Bugs only |
| `impact` | `varchar(20)` | `nice` / `often` / `every_ride`. Ideas only |
| `wantCount` | `integer` notNull default `0` | denormalized; written in the same transaction as the vote |
| `priority` | `smallint` | owner-only, never rendered publicly |
| `ownerNote` | `varchar(2000)` | private scratchpad |
| `publicResponse` | `varchar(2000)` | shown on the board when published |
| `duplicateOf` | `bigint` → `feedback.id` | self-reference, nullable |
| `replyOk` | `boolean` notNull default `true` | rider consented to a follow-up |
| `createdAt` / `updatedAt` / `publishedAt` | `timestamp` | `publishedAt` nullable |

Indexes: `uq_feedback_public_id` unique on `publicId`; `idx_feedback_board` on `(state, kind, wantCount)`; `idx_feedback_queue` on `(state, createdAt)`; `idx_feedback_author` on `authorId`.

`feedback_votes`

| column | notes |
|---|---|
| `feedbackId` | → `feedback.id` `onDelete: 'cascade'` |
| `userId` | → `users.id` `onDelete: 'cascade'` |
| `createdAt` | |

Composite primary key `(feedbackId, userId)`. **That key is the entire anti-fraud mechanism**—one want per rider per report, enforced by Postgres rather than by a check in the handler.

`feedback_diagnostics`

| column | notes |
|---|---|
| `feedbackId` | primary key, → `feedback.id` `onDelete: 'cascade'` |
| `payload` | `jsonb` notNull, `$type<Record<string, unknown>>()` |
| `createdAt` | |

Its own table because the blob is 5–50 KB and every board query would otherwise drag it across the wire. Follow the `surveyResponses.answers` precedent: the `$type<>` is a compile-time claim Postgres does not enforce, so every read goes through a lenient parser rather than a cast.

`feedback_attachments`

| column | notes |
|---|---|
| `id` | `bigserial` pk |
| `feedbackId` | → `feedback.id` `onDelete: 'cascade'` |
| `storageKey` | `varchar(255)`—path under `STORAGE_PATH`, same convention as `src/maps/storage.ts` |
| `mime` / `bytes` / `width` / `height` | |
| `createdAt` | |

> **Gate—schema approval.** Post this as a `schema.ts` diff and stop. After approval: `npm run db:generate`, read `drizzle/*.sql` before it is applied, confirm the differ did not emit a drop-plus-add for anything, then `npm run db:migrate`. Take a `db-backup` first—`AGENTS.md` is explicit that the production code is not precious and the production database is.

## Modules

Split rule from query, following `invites/`:

**`src/feedback/policy.ts`**—pure, no imports from `db/`. This is what the tests cover.

- `KIND_META`—the three kinds, their labels, which optional fields apply to each.
- `STATUS_META`—the rider-facing label and sub-line for every `feedbackStatus` value. Single source of truth for the copy in the table below.
- `titleFrom(body: string): string`—first sentence or first 80 characters, whichever is shorter, trimmed at a word boundary. Deterministic, so it is testable.
- `canWant(report, viewer)`—published, kind is `idea`, viewer is active, viewer is not the author (the author's want is auto-cast at publish).
- `visibleTo(report, viewer)`—published for anyone; author sees their own in any state; `canManageRiders` sees everything.
- `parseDiagnostics(raw: unknown)`—lenient, in the shape of `parseAnswers()` in the survey. Never casts.
- `SUBMIT_LIMIT`—reports per rider per hour.

**`src/feedback/service.ts`**—every query. `submitReport`, `listBoard`, `listQueue`, `listMine`, `moderate`, `toggleWant`, `mergeDuplicate`.

`toggleWant` and `mergeDuplicate` both write `wantCount` inside the same transaction as the vote rows. Merging a duplicate transfers wants and **de-duplicates by rider**—a rider who wanted both must not count twice.

**`src/feedback/diagnostics.ts`**—server-side shaping and redaction of the client payload. Strips query strings and fragments from any URL before storage. **Nothing reaches `jsonb` unredacted.**

**`src/emails/feedback-received.tsx`, `feedback-status.tsx`, `feedback-question.tsx`**—pure templates, added to `ALL_EMAILS` in `src/emails/index.ts`. Anything that reads a table to decide whether to send lives in `src/feedback/notify.ts`, following `src/auth/notify.ts`.

## Routes

New module `src/routes/feedback.tsx`, exporting `feedbackRoutes`, registered in `src/index.tsx` with `app.route('/', feedbackRoutes)` alongside the others. Add to `docs/api.md` in the same change.

| Route | Gate | Notes |
|---|---|---|
| `GET /feedback` | `requireActive` | The intake flow. Accepts `?kind=` and `?area=` so an in-app button can pre-fill both |
| `POST /feedback` | `requireActive` + `requireSameOrigin` | Form-encoded. Creates the report, the diagnostics row and any attachments in one transaction |
| `GET /feedback/mine` | `requireActive` | "My reports"—what they wrote, when, current status in plain words, any note from the owner |
| `GET /feedback/:publicId` | `requireActive` | One report. `visibleTo` decides; a report the viewer may not see is a 404, not a 403, matching the ride-slug precedent |
| `GET /board` | `requireActive` | Published ideas, default sort by wants. **Signed-in only**—an anonymous board on an invite-only beta is a scraping target with no upside, exactly the reasoning already applied to `/riders` |
| `POST /board/:publicId/want` | `requireActiveApi` + `requireSameOrigin` | Idempotent toggle. Returns the new count as JSON |
| `GET /admin/feedback` | `requireManageRiders` | The queue. Pending first, then everything, filterable by kind and state |
| `POST /admin/feedback/:id` | `requireManageRiders` + `requireSameOrigin` | One handler, action in the body: publish, decline, duplicate, spam, set status, set priority, save note, save public response |

`NavKey` in `src/views/layout.tsx` gains `'feedback'` and `'board'`. The queue reuses `'admin'`.

> **Gate—where the entry point lives.** `docs/main-menu.md` owns the menu. Three candidates, and this is Ziad's call: a persistent item in the account menu; a floating button on the builder and viewer only; or both, with the floating button pre-filling `?area=`. The floating button is what makes `area` inferable rather than asked, which is worth real accuracy on the intake—but it is also chrome on the two screens with the least room for it.

## The intake flow

One typed field. Everything after it is a tap, optional and skippable, and **the send button is live from the first screen onward.** That last point is the highest-leverage decision in the design; do not gate it behind the optional screens.

Server-rendered, one screen per step, following `routes/survey.tsx`—which already solves multi-step form state without a bundler. GET is inert; every write is a POST with `requireSameOrigin`.

### Screen 1—the fork

> **What's going on?**
>
> **Something's broken**—It didn't work, looked wrong, or wouldn't load
> **I've got an idea**—Something RouteLoop should do that it doesn't
> **I've got a question**—Not sure how something works? Ask away
>
> *Not sure which?* **Just start typing →**

Three tap cards, minimum 88px tall. The escape hatch drops them into the bug path with `kind` unset for the owner to classify. Never let the fork be the abandonment point.

### Screen 2—bug path, the only required field

> **What happened?**
> Plain words are perfect. No need to be technical.
>
> *[textarea, autofocused, 6 rows, **no placeholder text**]*
>
> Something like: "I hit save on my Blue Ridge route and the map went white."
>
> Wearing gloves? Tap the mic on your keyboard and just talk.
>
> **[ Next ]**  *Send it now*

The example goes in persistent helper text below the box, not in a `placeholder`—placeholder text vanishes on focus and measurably raises error rates. Minimum length 3 characters; no maximum. `autocapitalize="sentences"`, `enterkeyhint="next"`.

### Screen 3—where

Skip entirely when `?area=` arrived from the entry point; show a confirm chip instead:

> Looks like this happened in the **Route Planner**. **[ Yep ]** [ Somewhere else ]

Cold from the menu, a single-select chip group: Planning a route · Looking at the map · Saving or opening a ride · My saved rides · Sharing a ride · Signing in / my account · Somewhere else · Not sure.

**Chips, never a `<select>`.** A native select on iOS opens a wheel picker with ~34px rows, which is unusable with gloves.

### Screen 4—frequency, which is "steps to reproduce" in disguise

> **Does it do it every time?**
> Helps us find it faster.
>
> [ Every time ] [ Sometimes ] [ Just the once so far ] [ Don't know ]

### Screen 5—the picture

> **Got a picture of it?**
> A screenshot beats a thousand words. If you already took one, it's probably at the top of your photos.
>
> **[ Add a screenshot or photo ]**  *Skip this*

`<input type="file" accept="image/*" multiple>`, max 3. **Do not set `capture="environment"`**—it forces the camera and blocks the screenshot they already took. Accept a photo of the screen taken with another phone; riders do this and it is still diagnostic.

### Idea path

Screen 1 identical. Then:

> **What do you wish RouteLoop did?**
> Doesn't have to be polished. Half-formed is fine.

> **When did you last wish you had it?**
> The story helps more than the feature does, honestly.
>
> Like: "Planning a 3-day trip through Colorado and I couldn't figure out where I'd end up each night."

Never ask "what problem does this solve" or "what's your use case". People cannot write a problem statement; they can tell you about last Saturday. This field is optional and will still fill at a high rate because it asks for a story.

> **How much would this change your rides?**
>
> [ Nice to have ] [ I'd use it a lot ] [ I work around this every single ride ]

That third option is the entire prioritization signal and it is a sentence a rider would say out loud.

### Question path

One screen: the question, plus up to three live FAQ matches from `src/content/faq.html` under the box, plus the pre-filled email. Both fields required—you cannot answer a question you cannot reply to.

### Confirmation

Full screen, not a toast. Riders need to believe it landed.

> **Got it. Thanks.**
> A real person reads every one of these—usually same day.
> We grabbed the technical bits automatically, so you don't have to explain any of it.
> **Your report: #1042**

Idea path ends with "Nice one. It's on the board" only once it is actually published; before that it says it is with us and they will hear back. **Do not tell a rider their idea is on the board while it is `pending`**—the board is moderated and the message would be a lie the first time something is declined.

## Diagnostics, captured silently

Collected client-side, posted as a hidden field, redacted server-side by `src/feedback/diagnostics.ts` before it reaches `jsonb`. No rider is ever asked a technical question.

- **App and route**—build version, the normalized route pattern (`/m/:slug/roadbook`) as a separate field from the URL, referrer. **Query strings and fragments stripped.** The normalized pattern is what lets six unrelated-looking reports be recognized as one broken screen.
- **Device**—`userAgent` always, `userAgentData` when present (Chromium only), OS, browser, viewport, DPR, screen size, orientation, standalone/PWA display mode.
- **Preferences**—locale, timezone, `prefers-color-scheme`, `prefers-reduced-motion`.
- **Errors**—last 25 `console.error`, `window.onerror` and `unhandledrejection` entries with stacks; last 10 failed or slow `fetch`/XHR calls with method, path, status and duration.
- **Client health**—online state, `navigator.connection` **feature-detected** (absent on Safari and Firefox; a bare read inside the error reporter is a crash in the crash handler), `localStorage` quota and usage, whether the tab was backgrounded and restored. A full quota and a Safari tab eviction are two of the most common causes of "it lost my route".
- **Permission states only**—geolocation granted/denied. **Never coordinates.**

A capped ring buffer over the error sources is roughly 60 lines in `public/js/feedback.js` and needs no dependency. Install it early in `public/js/site.js` so it is already buffering before anything breaks.

One line under the send button, with a tappable expander:

> We attach a few technical details about your phone and what the app was doing. No location, no personal info.

> **This obligates a `src/content/privacy.html` update in the same change.** Storing UA plus timestamps plus account id is personal data. Ninety days is a defensible retention window; the `onDelete: 'cascade'` on `authorId` already handles GTFO.

## The map problem, which is specific to this app

**No DOM-capture library can screenshot the map, and it is not the library's fault.** Google Maps' vector renderer composites through WebGL and does not expose a `preserveDrawingBuffer` option, so `toDataURL()` on that canvas returns blank. Every capture library—html2canvas, snapdom, modern-screenshot—would hand back a clean picture of the app chrome wrapped around an empty rectangle where the map was. `html2canvas` is additionally unmaintained since January 2022 and reimplements a CSS engine in JavaScript, which means it silently drops any modern CSS it does not recognize.

So: **no capture library, no new dependency, and no attempt at automatic screenshots.** The file input above is the whole answer. Every rider already knows the power-plus-volume gesture, and it works identically on every device.

What replaces the screenshot is a small block of map state in the diagnostics—provider, style id, center, zoom, bearing, pitch, ride id, day index, stop count, tile error count, whether an export or handoff was in flight. For a route-planning app that reproduces more bugs than an image would, and it costs nothing.

> **Gate—how to read map state without breaking the boundary.** `public/js/map-common.js` is the only file allowed to name `google.maps`, and `viewer.js` and `builder.js` go through the handles it returns. Reading center and zoom means either (a) `map-common.js` exposes a `TBMap.snapshot()` that returns a plain object, which is a change to the boundary file and needs Ziad's sign-off, or (b) `feedback.js` reads a small state object that `viewer.js` and `builder.js` already maintain and publish on `window`, naming no vendor API and leaving the boundary intact. **(b) is the lower-risk option and the one to propose first.** Do not modify `map-common.js` on your own initiative.

## The board and the rider's own view

Two rules for status labels: **one motorcycle metaphor maximum**, and every status is a sentence about what is true, not a workflow state. `STATUS_META` in `policy.ts` is the single source.

| `status` | Label | Sub-line |
|---|---|---|
| `new` | We've seen it | Read it, haven't dug in yet |
| `needs_info` | We need one more thing from you | Check your email—we asked a question |
| `confirmed` | Yep, that's a bug | We reproduced it. It's ours to fix. |
| `planned` | We're going to build this | Not started yet, but it's happening |
| `in_progress` | In the shop | Being worked on right now |
| `shipped` | Fixed and live · Built and live | Go try it |
| `on_list` | On the list | Good idea, not soon. Still counting wants. |
| `not_doing` | We're not doing this one | Always paired with a one-line reason |
| `no_repro` | We couldn't make it happen | Tell us more if you see it again |
| `by_design` | That's how it works on purpose | Explains why, links to the FAQ |

Banned from every rider-facing surface, in code and in copy: *triaged, backlog, won't fix, P0/P1/P2, sev, repro, epic, sprint, deprioritized, invalid, user error.*

Board sorting defaults to most wanted, with newest and recently shipped as alternatives. **Put a "Recently shipped" strip at the top permanently**—it is the proof that submitting works, and it is what earns the next report.

## Client JavaScript

Two new files under `public/js/`, both plain ES modules, no bundler, matching the existing per-glob prettier override:

- **`feedback.js`**—the error ring buffer, the diagnostics collector, client-side image downscale to 1600px on the long edge via canvas before upload, and the want button's `fetch`. **The canvas re-encode also strips EXIF, which matters here specifically: riders will attach ride photos and EXIF carries GPS coordinates.** Publishing an idea with a geotagged photo attached would leak a rider's home address.
- **`feedback-buffer.js`**—if the ring buffer is worth testing on its own, split it out and `eval` it from a test, following the `ride-time.js` / `twist.js` / `route-shape.js` / `builder-history.js` precedent. Judgement call; four pure client helpers already work this way.

The intake form itself must work without any of it. `feedback.js` enriches; it is not load-bearing.

## Styles

New partial `style/_feedback.scss`, `@use`d from `style/main.scss` **before `responsive`**—order matters and responsive must stay last so its media queries win.

- Tap targets **56–60px tall with 12–16px between adjacent targets**. WCAG 2.2 AA floors at 24px and AAA at 44px; a gloved thumb at a gas stop needs more than AAA.
- Body text minimum 17px, labels 20px semibold. **No thin or light font weights anywhere in this flow**—they smear in glare.
- Contrast target 7:1 on body text, not the 4.5:1 minimum. No gray-on-gray helper text.
- The send button is full-width, 60px, bottom-anchored above the keyboard.
- Reuse tokens from `style/_tokens.scss`. `test/tokens.test.ts` exists—check whether it constrains what you add before adding it.

> **Gate—the bright-sun problem.** A dark UI on a phone screen in direct sunlight is close to unreadable, and this flow is used outdoors more than any other screen in the app. Options: ship the feedback flow light-mode-first regardless of the system theme; add a one-tap "Bright sun" toggle at the top of the flow; or do nothing and accept it. This is a design call and it is Ziad's.

## Files

**New**

```
src/feedback/policy.ts            pure rules, kind and status metadata
src/feedback/service.ts           every query
src/feedback/diagnostics.ts       shaping and redaction
src/feedback/notify.ts            table-reading send decisions
src/routes/feedback.tsx           intake, board, mine, admin queue
src/emails/feedback-received.tsx
src/emails/feedback-status.tsx
src/emails/feedback-question.tsx
public/js/feedback.js
style/_feedback.scss
test/feedback-policy.test.ts
test/feedback-diagnostics.test.ts
test/feedback-status-labels.test.ts
```

**Modified**

```
src/db/schema.ts                  four tables, three enums     [approval gate]
src/index.tsx                     app.route('/', feedbackRoutes)
src/views/layout.tsx              NavKey gains 'feedback' | 'board'
src/emails/index.ts               three templates into ALL_EMAILS
src/content/privacy.html          what the diagnostics hold, and for how long
style/main.scss                   @use "feedback" before responsive
public/js/site.js                 install the ring buffer early
docs/api.md                       eight routes and their gates
docs/database.md                  four tables
docs/main-menu.md                 the entry point, once decided
docs/STATUS.md                    what changed
AGENTS.md                         only if a convention here is new
drizzle/*.sql + drizzle/meta/     generated, never hand-edited
```

## Sequencing

Seven commits, each one green on its own. Conventional Commits, branch `feat/rider-feedback`.

1. **`feat(feedback): schema for reports, wants, diagnostics and attachments`**—`schema.ts` plus the generated migration. **Stops at the approval gate before `db:generate`.**
2. **`feat(feedback): pure policy module and status vocabulary`**—`policy.ts` and its tests. No routes yet. Fully testable with no database, which is the point of doing it first.
3. **`feat(feedback): intake flow and submission`**—`service.ts`, `diagnostics.ts`, the `GET`/`POST /feedback` screens, `/feedback/mine`, the SCSS partial, `feedback.js`. Riders can submit; nothing is public yet.
4. **`feat(feedback): owner queue`**—`/admin/feedback`, the moderation handler, `notify.ts`, the received email. **At the end of this commit the system is already useful**—reports arrive, you triage them, riders can see their own. Everything after is the public half.
5. **`feat(feedback): public board and wants`**—`/board`, the want toggle, the auto-cast of the author's want at publish.
6. **`feat(feedback): status emails and duplicate merging`**—the status template, `mergeDuplicate` with rider-deduplicated vote transfer.
7. **`docs: feedback endpoints, tables and menu`**—`api.md`, `database.md`, `main-menu.md`, `STATUS.md`, `privacy.html`.

Commits 1–4 are the whole product for an invite-only beta. **Commits 5 and 6 are worth holding.** At current rider counts the top idea will show single-digit wants, which is indistinguishable from "the four loudest people" and is displayed to exactly the audience you want believing the product has traction. Ship the board when there is a request that has arrived five or more times—that is the empirical proof that dedup-by-wants would save time, and until then it is a solution to a hypothesis.

## Verification

Per `AGENTS.md`, in order, before reporting any commit complete:

1. `npm run typecheck`
2. `npm test`
3. `npm run sass`—commits 3 and later touch `style/`
4. `npm run check:dashes`—every commit here touches prose

Automated coverage is pure logic only, so the tests to write are: `titleFrom` on awkward input (no sentence break, one word, 4000 characters, leading whitespace); `visibleTo` and `canWant` across every state and viewer combination; `parseDiagnostics` on a truncated, empty and hostile payload; and `STATUS_META` completeness—a test that every `feedbackStatus` enum value has a label and a sub-line, so adding a status without copy fails the build rather than rendering a raw enum to a rider.

Manual browser pass, which nothing automated covers:

- **A real phone, both iOS Safari and Android Chrome, in browser and installed-as-PWA.** Mobile file inputs, the iOS keyboard shoving the submit button off-screen, and PWA-context differences are where this breaks, and they surface only on hardware.
- Submit with the one required field and nothing else. It must succeed from screen one.
- Submit with three 12 MB photos. Confirm the client downscale ran, EXIF is gone from what landed, and `users.used_bytes` did not move.
- Break something on purpose—throw in a handler, kill the network mid-save—then submit, and confirm the ring buffer caught it and the redaction stripped the query string.
- Publish an idea, want it from a second account, merge a duplicate, confirm the count is right and the author was not double-counted.
- Delete an account with reports and wants attached and confirm the cascades fire.

## Open calls, collected—all four answered 2026-08-16

**Nothing here is open.** The four calls below were put to Ziad and answered on 2026-08-16, and the whole spec shipped that day across seven commits. They are kept as a record of what was decided and why, not as questions. The inline markers earlier in this document should be read the same way.

1. **Entry point placement—both.** An account-menu item ("Tell us something", "Idea board") *and* a floating button on the builder and viewer that pre-fills `?area=`.
2. **Map state—option (b), the plain state object on `window`.** `public/js/map-common.js` was not touched and the boundary is intact.
3. **Bright-sun handling—light-mode-first, regardless of system theme**, carried by the `feedback-flow` body class. `style/_feedback.scss` is pinned to light values with no `prefers-color-scheme` block, deliberately. Roadmap item 20 now records this as a dependency: `.feedback-flow` is the surface the dark scheme must skip.
4. **Ship commits 5 and 6 now.** The board did not wait for a request to arrive five or more times. This overrules the suggestion made earlier in this document.

**A fifth call came up mid-sprint and was settled: no automatic screenshots.** This document rules out DOM-capture libraries because Google Maps composites through WebGL, and that holds—but the stronger reason is that BugHerd-style capture uses `getDisplayMedia()`, which *would* capture the map correctly since it captures the composited frame, and which is **unsupported on every mobile browser**: iOS Safari, Android Chrome, Android Firefox and Samsung Internet, all current versions. The audience is riders on phones, so a file input is the whole answer. Recorded so it is not re-litigated.

**The 90-day diagnostics retention in this plan was deliberately not built.** `src/content/privacy.html` says so plainly rather than naming a window nothing enforces; diagnostics are deleted with the account by cascade. Decided 2026-08-16—not an oversight.

## Still to verify

Neither of these is reachable by a test, and both want doing before a tester sees the app.

- **No email has ever been delivered.** Local has no SMTP, so every send logs "skipped: mail is not configured" and returns. The call paths are wired and do not break the flows they hang off, but nothing has confirmed a message arrives.
- **The flow has only been driven in a desktop browser.** The Verification section above asks for a real phone—iOS Safari and Android Chrome, in-browser and installed as a PWA—because mobile file inputs and the iOS keyboard shoving the submit button off-screen only surface on hardware.
