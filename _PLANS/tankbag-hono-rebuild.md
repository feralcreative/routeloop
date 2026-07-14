# tankbag.app — TypeScript + Hono Rebuild Plan

Supersedes the PHP/MySQL plan in `multi-tenant-rebuild.md` (backend only) as of
2026-07-13. Hosting is the Synology NAS behind Cloudflare Tunnel; tunnel routes for
`tankbag.app` (:6686) and `stage.tankbag.app` (:6687) are already pre-staged.

## Stack

- Runtime: Node (Docker on `feral-nas`); portable to Cloudflare Workers via Hono
- Web framework: Hono
- Database: PostgreSQL, Drizzle ORM (PostGIS added later for geo discovery)
- Auth: Lucia (or Auth.js) — Google + GitHub OAuth, server sessions
- Validation: Zod
- Bot protection: Cloudflare Turnstile
- Frontend: reuse the existing vanilla-JS Google Maps viewer (`public/js/main.js`);
  migrate to MapLibre GL + vector tiles later
- Deploy: Docker container, prod `:6686` / stage `:6687`

## Preserved from the PHP build

- `public/js/main.js` viewer and its fixes (`esc()` XSS escaping, per-map color,
  single KML fetch, absolute icon paths)
- Security model: XXE-safe XML parsing (reject `DOCTYPE`, no network), transactional
  quota, KML sanitization, visibility gating that returns 404 for unknown/forbidden
  slugs
- Data model shape (`users`, `user_identities`, `maps`) — translated MySQL to Postgres
- Waypoint naming convention and the viewer metadata contract

## Phases (mirror the original milestones)

- Phase 0 — Scaffold: project skeleton, `tsconfig`, Dockerfile (Node), `docker-compose`
  (app + Postgres), Drizzle config, env/config loader; Hono serving the viewer.
- Phase 1 — One stored map renders: Hono public endpoints (`GET /`, `GET /m/:slug`,
  `GET /api/public/maps/:slug`, gated `/kml` and `/gpx`), seed one map, verify in a
  browser (route, arrows, markers, legend, downloads; single KML fetch; no console
  errors).
- Phase 2 — Auth: Lucia + Google/GitHub OAuth, sessions, `users` + `user_identities`,
  dashboard shell.
- Phase 3 — Upload + quota: drag-and-drop upload, XXE-safe parse, server-side metadata
  extraction, KML sanitization, transactional quota, owner endpoints
  (list / delete / update visibility).
- Phase 4 — Browse + share: public discovery page, share-link UI, full visibility
  gating.
- Phase 5 — Deploy: deploy script (Docker-on-NAS archetype), Postgres on the NAS,
  migrations, verify through the tunnel on `:6686` / `:6687`.
- Later — PostGIS geo discovery ("routes near me", bbox); MapLibre + vector tiles.

## Open setup choices (proposed defaults)

- Repo: restructure `tankbag-app` in place — keep `public/`, `docs/`, `_PLANS/`;
  replace `app/` (PHP) with `src/` (TS). Keep git history.
- Package manager: pnpm.
- Postgres: a container in the same `docker-compose` (not the NAS's MariaDB).
