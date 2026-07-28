# Google Cloud setup for routeloop

**Written:** 2026-07-26
**Covers:** the single Google Cloud project backing Sign in with Google and the
Google Maps engine, following the decision to drop Apple and move off Mapbox.

Everything below is configuration in the Cloud console, not code. Two findings
are worth reading before you start, because both are easy to walk into and
expensive to walk back out of.

## Two things to get right up front

### Sign-in alone needs no verification and has no user cap

The 100-user cap and the "unverified app" warning apply **only to apps that
request a sensitive or restricted scope**. Plain sign-in — `openid`, `email`,
`profile` — is non-sensitive. An app requesting nothing else can go to
production, serve unlimited users, and never sit through a review.

That is a genuinely good position, and it is fragile.

### Do not put a Gmail scope on the sign-in client

The moment `gmail.send` is added to the OAuth client that handles sign-in, that
client becomes a sensitive-or-restricted app. Consequences, all at once:

- The unverified-app interstitial appears before your consent screen.
- You are capped at **100 users** until verification completes.
- Verification takes roughly 2–6 weeks.
- Gmail scopes additionally trigger a **CASA security assessment**, repeated
  annually, at a few hundred to a few thousand dollars a year.

None of that is necessary, because **you are not sending mail as the signed-in
user**. Magic links are sent by your server, from your address, to them. That is
an outbound server credential and has nothing to do with the user's OAuth grant.

Whatever you use to send — Workspace SMTP relay, an app password, a service
account, or a transactional provider — keep it on a **separate credential from
the sign-in client**, and add no Gmail scope to the sign-in consent screen.

<!--| PAGE-BREAK -->

## APIs to enable

Enable these in **APIs & Services → Library**.

| API                 | Why                                               | Notes                                                 |
| ------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| Maps JavaScript API | Renders the map, replaces Mapbox GL JS            | Billed as Dynamic Maps, $7/1k after 10k free          |
| Places API (New)    | Search box, autocomplete, place details           | Enable the **New** one, not the legacy Places API     |
| Routes API          | Per-leg routing, replaces Mapbox Directions       | See the warning below                                 |
| Geocoding API       | Profile home address → coordinates                | Server-side only                                      |
| Maps Static API     | Optional — `og:image` thumbnails for shared rides | Currently a real gap; shared links have no card image |

### Routes API, not Directions API

**The Directions API is closed to new projects.** It moved to Legacy status on
1 March 2025 and cannot be enabled on a project that was not already using it.
`DirectionsService` in the Maps JavaScript API was deprecated on 25 February 2026.

This matters more than a name change, because Routes API is shaped differently
from what the builder does today against Mapbox:

- `POST` to `https://routes.googleapis.com/directions/v2:computeRoutes`, with
  parameters in a JSON body — not a `GET` with query parameters.
- A **field mask** header is mandatory, and it drives the price. Requesting more
  fields moves you up the SKU tiers, so ask for the minimum: the polyline,
  distance and duration.
- One upside worth having: Routes API supports a `TWO_WHEELER` travel mode.
  Given what this app is for, that is a better fit than anything Mapbox offered.

Assume the per-leg routing code is a rewrite, not a port.

## OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID → Web
application.**

### Scopes

Request exactly these three and nothing more:

```text
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
```

All three are non-sensitive. Adding anything beyond them changes your
verification posture — see the warning above.

### Authorized redirect URIs

The server-side flow means only redirect URIs matter; JavaScript origins are not
needed. One client can hold every environment:

```text
http://localhost:6686/auth/google/callback
http://127.0.0.1:6686/auth/google/callback
https://stage.routeloop.app/auth/google/callback
https://routeloop.app/auth/google/callback
```

Both localhost forms are listed deliberately — `isAllowedOrigin` in
[src/config.ts](../src/config.ts) already accepts either in development, and the
two are not interchangeable to Google.

### Consent screen

Publishing status **In production**, user type **External**. With only
non-sensitive scopes this needs no review. Fill in:

- App name, user support email, developer contact email
- App logo — use `logo-routeloop-vert@2x.png`
- Authorized domains: `routeloop.app`
- A privacy policy URL and terms URL. These are required fields for a published
  external app, and neither exists yet. Two static pages.

<!--| PAGE-BREAK -->

## API keys

Create **two**, and never let the server key reach the browser.

### Browser key

Used by Maps JavaScript API and any Places call made from the page.

- Application restriction: **HTTP referrers**
- Referrers: `https://routeloop.app/*`, `https://stage.routeloop.app/*`,
  `http://localhost:6686/*`
- API restriction: Maps JavaScript API, Places API (New)

A browser key is public by definition — it ships in the page source. Referrer
restriction is the only thing standing between it and someone else's bill, so
it is not optional.

### Server key

Used by Geocoding, and by Routes if you proxy routing through the origin.

- Application restriction: **IP addresses**, set to the NAS egress IP
- API restriction: Routes API, Geocoding API, Maps Static API

**Recommendation: proxy routing through your own server rather than calling
Routes API from the browser.** It keeps the key IP-restricted rather than
public, it lets you cache identical legs, and it sidesteps the question of
whether Routes API is reachable cross-origin from a browser at all — something
I have not verified and would rather not build on.

## Billing and guardrails

Maps Platform requires a billing account even to use the free tiers. Before
enabling anything:

1. Attach a billing account to the project.
2. Set a **budget with alerts** at a threshold you would notice.
3. Set **per-API daily quota caps** under each API's Quotas page.

The third is the one people skip. A budget alert tells you after the money is
spent; a quota cap stops it. A loop in client code that re-routes on every
keystroke can put four figures on the card overnight, and the free tiers here
are small — Dynamic Maps is 10,000 loads a month, not Mapbox's 50,000.

## Environment variables

```text
# OAuth — sign in with Google
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Maps — two keys, different restrictions, never interchangeable
GMAPS_KEY=              # HTTP referrer restricted, ships to the page
GMAPS_SERVER_KEY=       # IP restricted, origin only
GMAPS_MAP_ID=           # required or Advanced Markers silently do not render

# Magic-link delivery — a separate credential from the OAuth client above
MAIL_FROM=
# plus whatever the chosen sender needs
```

The existing `GMAPS_KEY` belongs to the legacy Google viewer that Phase 4
retires. Do not reuse it — its restrictions were set for a different purpose,
and keeping the names distinct is what stops the old key quietly becoming the
new one.

<!--| PAGE-BREAK -->

## Checklist

```text
[ ] Create or choose the Cloud project
[ ] Attach billing, set a budget alert
[ ] Enable: Maps JavaScript, Places (New), Routes, Geocoding, Maps Static
[ ] Set daily quota caps on each
[ ] Create the OAuth client (Web application)
[ ] Add the four redirect URIs
[ ] Consent screen: External, In production, logo, privacy policy, terms
[ ] Confirm the scope list is exactly openid + email + profile
[ ] Create the browser key, restrict by referrer and API
[ ] Create the server key, restrict by IP and API
[ ] Put all four values in .env and the NAS .env
[ ] Choose a magic-link sender on a separate credential
```

## Open question — magic-link delivery

You said you would add magic link "through them", which I can read two ways and
which changes what gets built:

- **Google Identity Platform / Firebase Auth email-link sign-in.** Google
  handles both Google sign-in and passwordless email links, and sends the mail
  itself. No Gmail scope, no sender to run. It replaces the hand-rolled OAuth
  flow rather than sitting beside it, so it is a different implementation from
  the Arctic approach.
- **Rolling the magic link yourself and sending through Google** — Workspace
  SMTP relay or an app password. Keeps the app's own session model exactly as it
  is today, and reuses the `sessions` table pattern. Watch the sending limits:
  roughly 2,000 recipients per day on Workspace, 500 on a consumer account.

Nothing in this document changes either way — the scopes, keys and APIs above
are identical. Worth settling before the auth code is written.

## Confidence

Verified this session:

- The 100-user cap applies only to sensitive or restricted scopes
- Gmail restricted scopes require an annual CASA assessment
- Directions API is closed to new projects; Routes API replaces it, `POST` with
  a mandatory field mask
- `DirectionsService` in Maps JS was deprecated 25 February 2026

Not verified:

- Whether Routes API can be called directly from a browser. The proxy
  recommendation above avoids needing to know.
- The exact Places API field-to-SKU-tier mapping, which is the largest cost
  variable in the switch — see
  [decisions-auth-and-search.md](decisions-auth-and-search.md).
- Current Workspace and consumer Gmail sending limits.

## Sources

- [When verification is not needed](https://support.google.com/cloud/answer/13464323?hl=en)
- [Unverified apps](https://support.google.com/cloud/answer/7454865?hl=en)
- [Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Migrate to Routes API](https://developers.google.com/maps/documentation/routes/migrate-routes)
- [Why migrate to Routes API](https://developers.google.com/maps/documentation/routes/migrate-routes-why)
- [DirectionsService deprecation](https://developers.google.com/maps/documentation/javascript/reference/directions)
- [Google Maps Platform pricing](https://developers.google.com/maps/billing-and-pricing/pricing)
