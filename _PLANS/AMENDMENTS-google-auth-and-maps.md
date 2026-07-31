# Amendments to the Google auth + maps migration plan

**Written:** 2026-07-27
**Applies to:** [google-auth-and-maps-migration.md](google-auth-and-maps-migration.md)

The plan was written before anything was tested against the live Google APIs. Four of its statements turned out to be wrong or stale once probed. The plan file itself is kept verbatim so the original reasoning survives; this file is what wins where they disagree.

## 1. `TWO_WHEELER` does not work in the United States

The plan says:

> `TWO_WHEELER` mode exists and suits this app better than anything Mapbox offered. Worth using deliberately rather than defaulting to `DRIVE`.

This is wrong for a US app. `TWO_WHEELER` is served only in a handful of South and Southeast Asian markets. Outside them the Routes API returns **HTTP 200 with an empty body**—no route, no error, no explanation.

Verified 2026-07-27, identical requests, same key:

```text
Barstow -> Victorville, CA
  DRIVE        {"routes":[{"distanceMeters":71316,"duration":"3059s"}]}
  TWO_WHEELER  {}
  BICYCLE      {"routes":[{"distanceMeters":76088,"duration":"14725s"}]}

Jakarta, Indonesia
  TWO_WHEELER  {"routes":[{"distanceMeters":13324,"duration":"1920s"}]}
```

Had this shipped, every leg in the builder would have failed with "no road route" and nothing in the response to explain why. **Use `DRIVE`.** This is already encoded in [src/routes/routing.ts](../src/routes/routing.ts) with the reasoning in a comment so it does not get "fixed" back later.

## 2. The APIs were already enabled

The plan's console checklist says to enable five APIs. All of them were already enabled on the project. Verified live: Maps JavaScript, Places (New), Routes, and Geocoding all answered. No action needed.

## 3. The browser key was not referrer-restricted

Both [_AI_AGENT_PRIMER.md](../_AI_AGENT_PRIMER.md) and the old STATUS.md described `GMAPS_KEY` as "referrer-restricted to 127.0.0.1". It was not restricted at all—it answered with no `Referer` header and from arbitrary origins, while authorized for 35 separate Google APIs, and it ships in page source on every imported-ride view.

Fixed 2026-07-27. See STATUS.md for the applied restriction and its verification.

## 4. The Map ID really is console-only

The plan calls this out and it is correct, but it is worth recording that it was tested rather than assumed. `mapmanagement.googleapis.com` is enabled on the project and appears in the key's API target list, which suggests a programmatic path. There is none—every REST path returns 404 and there is no `gcloud maps` command group. It must be created in the Cloud console by hand.

## What was confirmed correct

- **`route_legs.geometry` needs no migration.** Routes API with `polylineEncoding: GEO_JSON_LINESTRING` returns coordinates in `[lng, lat]` order, exactly what the column already stores. Verified against a real 218-point response.
- **`map-common.js` is a real abstraction.** Six of its thirteen exports touch `mapboxgl`, at lines 16–127; everything from line 129 down is pure DOM and arithmetic.
- **Coordinate order is the live hazard.** It is worth the single-helper discipline the plan asks for—see `toGoogleWaypoint` in [src/routes/routing.ts](../src/routes/routing.ts), which is the only place in the routing path that reorders a pair.
