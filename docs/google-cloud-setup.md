# Google Cloud setup for routeloop

**Written:** 2026-07-26
**Updated:** 2026-07-27—both API keys now exist; see the checklist for what is left
**Covers:** the single Google Cloud project backing Sign in with Google and the Google Maps engine, following the decision to drop Apple and move off Mapbox.

Everything below is configuration in the Cloud console, not code. Two findings are worth reading before you start, because both are easy to walk into and expensive to walk back out of.

## Two things to get right up front

### Sign-in alone needs no verification and has no user cap

The 100-user cap and the "unverified app" warning apply **only to apps that request a sensitive or restricted scope**. Plain sign-in—`openid`, `email`, `profile`—is non-sensitive. An app requesting nothing else can go to production, serve unlimited users, and never sit through a review.

That is a genuinely good position, and it is fragile.

### Do not put a Gmail scope on the sign-in client

The moment `gmail.send` is added to the OAuth client that handles sign-in, that client becomes a sensitive-or-restricted app. Consequences, all at once:

- The unverified-app interstitial appears before your consent screen.
- You are capped at **100 users** until verification completes.
- Verification takes roughly 2–6 weeks.
- Gmail scopes additionally trigger a **CASA security assessment**, repeated annually, at a few hundred to a few thousand dollars a year.

None of that is necessary, because **you are not sending mail as the signed-in user**. Magic links are sent by your server, from your address, to them. That is an outbound server credential and has nothing to do with the user's OAuth grant.

Whatever you use to send—Workspace SMTP relay, an app password, a service account, or a transactional provider—keep it on a **separate credential from the sign-in client**, and add no Gmail scope to the sign-in consent screen.

<!--| PAGE-BREAK -->

## APIs to enable

Enable these in **APIs & Services → Library**.

| API                 | Why                                               | Notes                                                 |
| ------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| Maps JavaScript API | Renders the map, replaces Mapbox GL JS            | Billed as Dynamic Maps, $7/1k after 10k free          |
| Places API (New)    | Search box, autocomplete, place details           | Enable the **New** one, not the legacy Places API     |
| Routes API          | Per-leg routing, replaces Mapbox Directions       | See the warning below                                 |
| Geocoding API       | Profile home address → coordinates                | Server-side only                                      |
| Maps Static API     | Optional—`og:image` thumbnails for shared rides | Currently a real gap; shared links have no card image |

### Routes API, not Directions API

**The Directions API is closed to new projects.** It moved to Legacy status on 1 March 2025 and cannot be enabled on a project that was not already using it. `DirectionsService` in the Maps JavaScript API was deprecated on 25 February 2026.

This matters more than a name change, because Routes API is shaped differently from what the builder does today against Mapbox:

- `POST` to `https://routes.googleapis.com/directions/v2:computeRoutes`, with parameters in a JSON body—not a `GET` with query parameters.
- A **field mask** header is mandatory, and it drives the price. Requesting more fields moves you up the SKU tiers, so ask for the minimum: the polyline, distance and duration.
- One upside worth having: Routes API supports a `TWO_WHEELER` travel mode. Given what this app is for, that is a better fit than anything Mapbox offered.

Assume the per-leg routing code is a rewrite, not a port.

## OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.**

### Scopes

Request exactly these three and nothing more:

```text
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
```

All three are non-sensitive. Adding anything beyond them changes your verification posture—see the warning above.

### Authorized redirect URIs

The server-side flow means only redirect URIs matter; JavaScript origins are not needed. One client can hold every environment:

```text
http://localhost:6686/auth/google/callback
http://127.0.0.1:6686/auth/google/callback
https://stage.routeloop.app/auth/google/callback
https://routeloop.app/auth/google/callback
```

Both localhost forms are listed deliberately—`isAllowedOrigin` in [src/config.ts](../src/config.ts) already accepts either in development, and the two are not interchangeable to Google.

### Consent screen

Publishing status **In production**, user type **External**. With only non-sensitive scopes this needs no review. Fill in:

- App name, user support email, developer contact email
- App logo—use `_assets/logo-routeloop@2x.png` (1840×1036, the stacked dark artwork; Google renders it on a white consent screen). It is not under `public/`, because nothing on the site links to it and the console upload is a one-off.
- Authorized domains: `routeloop.app`
- A privacy policy URL and terms URL. These are required fields for a published external app, and neither exists yet. Two static pages.

<!--| PAGE-BREAK -->

## API keys

Create **two**, and never let the server key reach the browser.

### Browser key

Used by Maps JavaScript API and any Places call made from the page.

- Application restriction: **HTTP referrers**
- Referrers: `https://routeloop.app/*`, `https://www.routeloop.app/*`, `https://stage.routeloop.app/*`, `http://localhost:6686/*`, plus the matching `tankbag.app` hosts until the 301s are retired
- API restriction: Maps JavaScript API, Places API (New)

A browser key is public by definition—it ships in the page source. Referrer restriction is the only thing standing between it and someone else's bill, so it is not optional.

### Server key

Used by Geocoding, and by Routes if you proxy routing through the origin.

- Application restriction: **IP addresses**, set to the NAS egress IP
- API restriction: Routes API, Geocoding API, Maps Static API

**Recommendation: proxy routing through your own server rather than calling Routes API from the browser.** It keeps the key IP-restricted rather than public, it lets you cache identical legs, and it sidesteps the question of whether Routes API is reachable cross-origin from a browser at all—something I have not verified and would rather not build on.

## Billing and guardrails

Maps Platform requires a billing account even to use the free tiers. Before enabling anything:

1. Attach a billing account to the project.
2. Set a **budget with alerts** at a threshold you would notice.
3. Set **per-API daily quota caps** under each API's Quotas page.

The third is the one people skip. A budget alert tells you after the money is spent; a quota cap stops it. A loop in client code that re-routes on every keystroke can put four figures on the card overnight, and the free tiers here are small—Dynamic Maps is 10,000 loads a month, not Mapbox's 50,000.

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

The existing `GMAPS_KEY` belongs to the legacy Google viewer that Phase 4 retires. Do not reuse it—its restrictions were set for a different purpose, and keeping the names distinct is what stops the old key quietly becoming the new one.

<!--| PAGE-BREAK -->

## Checklist

Status as of 2026-07-27. The project is **`routeloop-503503`** (display name `routeloop`)—worth stating plainly, because `tankbag`, `routeloop-app-stage` and `feralcreative-routeloop-prod` all exist and none of them owns the Maps keys.

Console object names are deliberately left alone across product renames, so the names in this section are the literal ones in the console and are not to be "corrected" to match the current brand. A GCP project cannot be renamed in place anyway, and the keys are identified by uid.

```text
[x] Create or choose the Cloud project        routeloop-503503
[x] Attach billing                            billingAccounts/011AE1-146DA6-11525A
[ ] Set a budget alert
[x] Enable: Maps JavaScript, Places (New), Routes, Geocoding, Maps Static
[ ] Set daily quota caps on each               <- still open, and the one that
                                                  bounds the downside
[ ] Create the OAuth client (Web application)  <- blocks all sign-in
[ ] Add the redirect URIs
[ ] Consent screen: External, In production, logo, privacy policy, terms
[ ] Confirm the scope list is exactly openid + email + profile
[x] Create the browser key, restrict by referrer and API
[x] Create the server key, restrict by IP and API
[ ] Create a vector Map ID                     <- blocks Advanced Markers
[~] Put the values in .env and the NAS .env    GMAPS_KEY + GMAPS_SERVER_KEY are
                                               in the local .env; MAP_ID and the
                                               OAuth pair are not, and nothing
                                               has been put on the NAS yet
[ ] Create the magic-link sender credential
```

### What the keys ended up as

- **Browser key**—uid `010d908a-9158-4169-b5cb-98d8f08f6b16`. It was created with **no referrer restriction at all** and authorization for 35 APIs, which is how it shipped in page source for a while. It is now limited to `tankbag.app`, `www.tankbag.app`, `stage.tankbag.app`, `127.0.0.1:6686`, `localhost:6686`, and to Maps JavaScript + Places only. **This is the state as audited and it is not yet correct for routeloop.app**—the referrer list has to gain the routeloop hosts before that name goes canonical, or the browser key is blocked on its own site and the map never draws (`RefererNotAllowedMapError`) while every other part of the page looks fine.
- **Server key**—uid `a321c95b-05e3-4f11-82db-25baa39a9c55`, "routeloop server (Routes + Geocoding, IP-restricted)". Limited to IP `69.209.26.137` and to Routes + Geocoding. The NAS and the development workstation share that one residential address, so a lease change breaks server-side calls while the browser key keeps working.
- **Map ID**—not created. This is console-only despite appearances: `mapmanagement.googleapis.com` is enabled and appears in the key's API target list, but every REST path returns 404 and there is no `gcloud maps` command group. `DEMO_MAP_ID` works for local development and must not ship.

## Settled—magic-link delivery

This was an open question when the document was written; it is decided and built. The app **rolls its own magic link and sends it over Google SMTP** with an app password, rather than handing sign-in to Google Identity Platform / Firebase. That keeps the existing session model and the `sessions` table pattern intact, and it keeps Google OAuth as one identity provider among several rather than the whole auth system.

Two consequences to remember:

- The SMTP credential must live on an account **separate** from the OAuth client, and that account needs 2FA before an app password can be generated.
- Gmail sending caps at roughly 2,000 recipients per day on Workspace and 500 on a consumer account. Fine for an alpha; a wall later.

The implementation is [src/auth/magic.ts](../src/auth/magic.ts) (issue, send, redeem—hash-only storage, single use, 15-minute expiry, rate limited per address and per IP) and [src/auth/mailer.ts](../src/auth/mailer.ts) (nodemailer over SMTP).

## Confidence

Verified this session:

- The 100-user cap applies only to sensitive or restricted scopes
- Gmail restricted scopes require an annual CASA assessment
- Directions API is closed to new projects; Routes API replaces it, `POST` with a mandatory field mask
- `DirectionsService` in Maps JS was deprecated 25 February 2026

Not verified:

- Whether Routes API can be called directly from a browser. The proxy recommendation above avoids needing to know.
- The exact Places API field-to-SKU-tier mapping, which is the largest cost variable in the switch—see [decisions.md](decisions.md).
- Current Workspace and consumer Gmail sending limits.

## Sources

- [When verification is not needed](https://support.google.com/cloud/answer/13464323?hl=en)
- [Unverified apps](https://support.google.com/cloud/answer/7454865?hl=en)
- [Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Migrate to Routes API](https://developers.google.com/maps/documentation/routes/migrate-routes)
- [Why migrate to Routes API](https://developers.google.com/maps/documentation/routes/migrate-routes-why)
- [DirectionsService deprecation](https://developers.google.com/maps/documentation/javascript/reference/directions)
- [Google Maps Platform pricing](https://developers.google.com/maps/billing-and-pricing/pricing)
