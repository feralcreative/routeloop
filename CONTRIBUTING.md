# Contributing to Tankbag

Tankbag is a motorcycle ride planner: plan a whole multi-day ride on one map, hand it off to whatever you navigate with, share it over a link. This document is everything you need to get it running and land a change. If something here is wrong or missing, that is a bug in this file—say so.

## Before you start

Read [\_AI_AGENT_PRIMER.md](_AI_AGENT_PRIMER.md) for the architecture, then [docs/STATUS.md](docs/STATUS.md) for where things actually stand. [docs/ROADMAP.md](docs/ROADMAP.md) is the plan; this file is the mechanics.

**Picking something up.** Every open issue carries a **P0–P3** label and those labels are the authority on what matters, not the issue numbers. Anything tagged `good first issue` is scoped to be landable without holding the whole app in your head. The `area:*` labels say which part of the codebase a change touches—`area:schema` in particular means it has to be serialised against other schema work, because schema work has to be applied in order.

## Setup

You need **Node.js 20 or newer**, **Docker** for Postgres, and Google Cloud credentials—a referrer-restricted browser key, an IP-restricted server key and a vector Map ID. Without the Map ID, Advanced Markers render nothing at all and give you no error to go on. [docs/google-cloud-setup.md](docs/google-cloud-setup.md) walks through getting them.

```bash
npm install
docker compose up -d --wait db
cp .env.example .env        # then fill it in
npx drizzle-kit push        # apply the schema
npx tsx src/db/seed.ts      # one sample ride
npm run sass                # compile styles (the CSS is a build artifact, git-ignored)
```

[README.md](README.md#local-development) has the long version, including which `.env` keys actually matter and how to generate a set of varied demo rides worth looking at. One seeded ride is not enough to judge how anything reads.

### Turn on the pre-commit hook

```bash
git config core.hooksPath .githooks
```

Do this once per clone. Git does not enable repo hooks by default and nothing will remind you. The hook runs [utils/tighten-em-dashes.mjs](utils/tighten-em-dashes.mjs) over staged prose, tightens any spaced em dashes it finds, and re-stages what it changed. It fixes rather than blocks—the correction is mechanical, so stopping a commit to make you retype a dash would be friction for no gain.

## Running it

```bash
npm run dev          # the app on port 6686, plus the SCSS watcher and live reload
npm run dev:server   # the app alone, if you want to run sass yourself
npm test             # the suite, 765 tests, no database needed
npm run test:watch   # the same, watching
npm run typecheck    # tsc --noEmit
npm run sass         # compile SCSS — never an IDE extension
```

The app is at <http://localhost:6686>; `127.0.0.1` works equally well. The seeded ride is at `/m/sample-route-one` and the builder is at `/builder`.

### Live reload

`npm run dev` starts `sass --watch` alongside the server and the page picks the result up on its own—see [src/dev/livereload.ts](src/dev/livereload.ts). Save a `.scss` file and the stylesheet is swapped in place, without a page reload, so a map keeps its instance, its viewport and whatever ride you had loaded. Save anything under [public/js/](public/js/) and the page reloads; save anything under `src/` and `tsx watch` restarts the server, which the browser notices and reloads for.

It is development-only in the strict sense: both the `/__dev/reload` endpoint and the snippet that talks to it are gated on `IS_DEV`, which is `APP_ORIGIN` not being HTTPS—the same signal the dev sign-in leans on below. Nothing about it can render in stage or prod.

**Port 6686 belongs to this project.** If it is already bound, kill whatever holds it and reuse the port rather than starting on another one. Two instances on two ports is how you end up debugging the one you are not looking at.

### Signing in locally

`GET /dev/login` signs you in as the account named by `DEV_LOGIN_EMAIL`, no password and no email round trip. It only registers when `DEV_LOGIN_EMAIL` is set, `DATABASE_URL` points somewhere local, and `APP_ORIGIN` is not HTTPS—all three, so it cannot exist in a deployed environment. The server prints a warning at boot when it is on.

To mint a session without a browser at all:

```bash
npx tsx -e "import('./src/auth/session').then(async m => console.log(await m.createSession(1)))"
# send it as: Cookie: tankbag_session=<token>
```

### Calling the API by hand

Write endpoints check the request origin, so a scripted call needs the header or it fails with `{"error":"bad origin"}` and a 403:

```bash
curl -b cookies.txt -H "Origin: http://127.0.0.1:6686" \
  -X POST http://127.0.0.1:6686/api/maps \
  -F "route=@ride.gpx" -F "title=Test" -F "visibility=private"
```

## Gotchas that will bite otherwise

- **Coordinate order.** The app stores and speaks `[lng, lat]` (GeoJSON order); Google's JS objects speak `{lat, lng}`. Getting it backwards still renders a map, just in the wrong place. Exactly two functions convert—`toGoogleWaypoint` on the server and `toLatLng` / `fromLatLng` in `map-common.js`—keep it that way.
- **`public/js/map-common.js` is the only file that touches `google.maps`.** The viewer and builder go through the handles it returns. Preserve that boundary.
- **Schema is push-first, not push-only.** `npx drizzle-kit push` for ordinary changes—read the statement list before applying it; riders hold data that cannot be rebuilt from an upload. Anything push cannot express safely gets a hand-written file in [utils/deploy/sql/](utils/deploy/sql/): renames, which push would otherwise drop and recreate, and changed column defaults, which Postgres applies to new rows only. Those files are the exception to the `*.sql` gitignore rule and are tracked deliberately.
- **SCSS compiles with `npm run sass`**, never an IDE extension, and the compiled CSS is git-ignored.
- **Prose is never hard-wrapped.** One line per paragraph, and let the editor soft-wrap. Em dashes are tight—`word—word`, never `word — word`.

## Branches and commits

Branch as `type/kebab-subject`: `feat/trip-timeline-slider`, `fix/multi-track-import`, `chore/contributor-onboarding`.

Commit messages are [Conventional Commits](https://www.conventionalcommits.org/)—`type(scope): subject`, imperative mood. The types in use here are `feat`, `fix`, `refactor`, `docs`, `chore`, `style` and `test`. Scope is optional and welcome when it clarifies.

**Never commit, push or deploy without the owner's say-so.** That is not a formality: deploys go to a live site that riders have accounts on.

## Opening a pull request

Before you do:

```bash
npm run typecheck
npm test
npm run sass        # only if you touched the SCSS
```

CI runs the first two on every pull request, against Node 20 and 22. Say what changed and why, and link the issue it closes. A change that fixes something the tests did not catch should generally come with the test that would have.
