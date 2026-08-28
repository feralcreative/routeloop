# Zero-downtime deploy for routeloop

**Written:** 2026-08-25. **Updated:** 2026-08-27.

**Status: Phase 1 is BUILT and deployed to stage. Phase 2 is BUILT and has NOT been cut over anywhere.**

Phase 1 landed on `feat/zero-downtime-phase-1`: `/healthz`, the SIGTERM drain, migrations moved off the serving container into a one-shot `migrate` service, and a deploy that converges the database instead of tearing it down. It has **not been deployed to stage or prod**, and the one thing in it that cannot be verified from a laptop—whether SIGTERM actually reaches Node as PID 1 inside the container—is listed under *Verification* below and has to be done by hand on stage first.

Phase 2 landed on `feat/zero-downtime-phase-2`, branched off Phase 1. **All three of its approvals were given on 2026-08-27**: Caddy as a production dependency, expand/contract as a schema rule with a `--no-overlap` escape hatch, and `DB_VOLUME_NAME` hard-pinned per environment.

**What has NOT happened is the one-time NAS cutover**, which is the only step in either phase that can lose a database. Both environments are still running the single pre-blue/green container. The runbook below is unchanged and its preconditions are not optional.

Two things resolved that the plan left open:

- **Compose on the NAS is v2.20.1** (measured 2026-08-27), so profiles are available. Both colors and the migrator sit behind them, which is what makes a bare `up -d` unable to start both colors—the plan had hedged on this because Synology often ships Compose v1.
- **The plan's `health()` snippet read `process.env.APP_COLOR` inside a function described as pure.** `APP_COLOR` lives in `src/config.ts` with every other env-derived constant and is passed in.

## Context

Three real riders now have accounts on production. Every deploy currently takes the site down for roughly 60–90 seconds, and the reason is one line in `utils/deploy/deploy.sh`:

```bash
/usr/local/bin/docker-compose down || true
/usr/local/bin/docker-compose up -d
```

`down` tears out the app container, the Postgres container, **and** the bridge network. `up -d` then has to wait on `depends_on: db: condition: service_healthy` before the app can even start, and `tsx src/index.tsx` transpiles the whole TypeScript tree at boot. For that entire window nothing is listening on `127.0.0.1:16703`, so `cloudflared` gets connection-refused and Cloudflare serves a 502.

The goal is to deploy without that gap. The constraint that outranks it: **the production database is precious and must never be at risk.**

Three things already work in our favor: sessions are fully DB-backed (`src/auth/session.ts` stores `SHA-256(token)` as `sessions.id`, no shared secret), so two containers validate each other's sessions identically; `data/storage` is a bind mount that two containers can share; and `drizzle-kit migrate` is idempotent.

<!--| PAGE-BREAK -->

## The decision

| | Downtime | New parts | Data risk | Imposes a schema rule |
| --- | --- | --- | --- | --- |
| **Phase 1**—stop tearing down the db | ~10–20s | none | **none** | no |
| **Phase 2**—blue/green behind Caddy | ~0s | Caddy container, two app colors | one-time NAS cutover | yes |

**Recommendation: ship them as two PRs, Phase 1 first.** Phase 1 is a strict subset of Phase 2—every piece of it (`/healthz`, the SIGTERM handler, the health-gated verify, migrations moved off the serving container) is needed by Phase 2 anyway. Shipping it alone gets most of the win this week with no compose restructure and therefore no data risk at all, and it proves the two pieces most likely to be silently broken before they become load-bearing. If Phase 2 ever looks like more appetite than the problem deserves, stopping after Phase 1 leaves you with a much better deploy and nothing half-finished.

### Approvals needed before any code is written

Per the Prohibitions in `AGENTS.md`: Caddy as a new dependency, anything touching prod or stage, and the migration-authoring rule in the *Migrations* section below, which is effectively a schema-policy change.

<!--| PAGE-BREAK -->

## Phase 1—stop tearing down the database

**BUILT 2026-08-27, not yet deployed.** No new dependency, no topology change, no compose restructure. `~60–90s` becomes `~10–20s`.

What actually shipped, against what this section proposed:

| Proposed | Built | Difference |
| --- | --- | --- |
| `src/health.ts`, pure | `src/health.ts` + `test/health.test.ts` (13 cases) | `health()` takes `color` as an INPUT rather than reading `process.env.APP_COLOR` inside itself, which the draft snippet did—a pure function that reads a global is not one, and `APP_COLOR` now lives in `src/config.ts` with every other env-derived constant |
| `src/shutdown.ts` | `src/shutdown.ts`, `pool` exported from `src/db/index.ts` | as proposed |
| `HEALTHCHECK` moved to `/healthz` | done | as proposed |
| `CMD ["node", "--import", "tsx", …]` | done | `node --import tsx` verified against the pinned `tsx ^4.19.2`; the SIGNAL half is unverified in-container—see *Verification* |
| one-shot `migrate` service | done | as proposed, and `hooks/post-deploy.sh` deleted with its error text carried over verbatim into `deploy.sh` |
| health-gated verify asserting the SHA | done | as proposed; the old `sleep 5` plus non-fatal curl is gone |
| *(not in the plan)* | `utils/deploy/deploy-utils.sh` | `status` now reports `/healthz` and prints the body, so it names the BUILD running out there; `migrate` runs the one-shot service rather than `docker exec`, matching the recovery command the deploy's own failure message hands you |
| `stop_grace_period`, `DRAIN_GRACE_MS` | done | as proposed |

Measured locally: a drain completes in **265ms** with both log lines, and `/healthz` answers 200 with the stamped `APP_VERSION`/`BUILD_SHA` and is not caught by the `LEGACY_HOSTS` redirect under a `Host: tankbag.app` header.

### 1. A real health endpoint

Today the health probe is `/`, which renders the public ride list—a full DB query plus a full JSX render, every 30 seconds, forever. Replace it with something cheap that can also answer *which build am I*.

New `src/health.ts`, split rule-from-query the way `thumbnail.ts` is split from `thumbnail-sweep.ts`, so the shape is unit-testable with no database:

```ts
export type HealthInput = { version: string; build: string; dbUp: boolean; draining: boolean; uptimeSec: number }
export type HealthOut = { status: 200 | 503; body: Record<string, unknown> }

export function health(i: HealthInput): HealthOut {
  const ok = i.dbUp && !i.draining
  return { status: ok ? 200 : 503, body: { ok, version: i.version, build: i.build, color: process.env.APP_COLOR ?? '', db: i.dbUp ? 'up' : 'down', draining: i.draining, uptime: i.uptimeSec } }
}
```

Wired in `src/index.tsx` as the **first** route, above the `LEGACY_HOSTS` middleware and above `withSession`. Above `LEGACY_HOSTS` because a probe must never be answered with a 301, and the deploy probes with `Host: 127.0.0.1`. Above `withSession` because a health check that does a session lookup is measuring the wrong thing.

The `Dockerfile` `HEALTHCHECK` target moves from `/` to `/healthz`, and the comment above it (which currently justifies `/` with "renders the public map list, so it exercises the DB connection too") gets rewritten.

**One call for you:** `/healthz` is unauthenticated and would put `BUILD_SHA` on a public URL. `src/version.ts` says the SHA is deliberately not shown beside the version, but it already rides in a `title` attribute and in feedback diagnostics, so it is already in the DOM of every page. My read is that this changes nothing material. If you'd rather it didn't, the proxy can `respond 404` for `/healthz` on the public listeners in Phase 2 and the deploy probes containers directly.

### 2. Graceful shutdown, and the trap inside it

There is no `SIGTERM` handler anywhere in `src/` today. On `docker stop` the container gets SIGTERM, nothing catches it, and ten seconds later Docker SIGKILLs it—dropping whatever request was mid-flight. That is invisible with a `down`/`up` deploy because the whole stack was down anyway. It becomes the entire remaining source of dropped requests once Phase 2 exists.

New `src/shutdown.ts`, a separate module so `/healthz` near the top of `index.tsx` can read the draining flag without a circular import:

```ts
export function installShutdown(server: Server, graceMs: number): void {
  const go = (signal: string) => {
    if (draining) return
    draining = true
    // Stops accepting NEW connections and waits for in-flight responses. It does
    // NOT close idle keep-alive sockets, and the proxy holds those open — so
    // without closeIdleConnections the drain waits out keepAliveTimeout on each.
    server.closeIdleConnections()
    const forced = setTimeout(() => server.closeAllConnections(), graceMs)
    forced.unref()
    server.close(() => pool.end().catch(() => {}).finally(() => process.exit(0)))
  }
  process.once('SIGTERM', () => go('SIGTERM'))
  process.once('SIGINT', () => go('SIGINT'))
}
```

Two details that will bite if missed:

**`serve()` does not return `node:http.Server`.** `@hono/node-server` types it as `Server | Http2Server | Http2SecureServer`. All three have `.close()`, but `.closeIdleConnections()` and `.closeAllConnections()` exist only on the plain HTTP server. Since we never pass `createServer` and never enable HTTP/2 it is always that one, so narrow with `as HttpServer` and confirm with `npm run typecheck`.

**THE PID 1 PROBLEM—this is the one that fails silently.** The `Dockerfile` ends with `CMD ["npm", "run", "start"]`, so **npm** is PID 1. npm's signal forwarding to its child is historically unreliable, and there may be a second hop through `tsx`. If SIGTERM does not reach the Node process, the handler above is dead code and every deploy still hard-kills in-flight requests—while every log line says it worked. Fix by making Node PID 1:

```dockerfile
CMD ["node", "--import", "tsx", "src/index.tsx"]
```

`tsx ^4.19.2` supports `node --import tsx`, but **this must be verified by hand, not assumed.** The acceptance test is on stage: `docker stop <container>`, confirm `[shutdown] SIGTERM received, draining` appears in `docker logs`, **and** that the container exits in about a second rather than taking the full ten-second SIGKILL timeout. Fallback if it doesn't work: `CMD ["./node_modules/.bin/tsx", "src/index.tsx"]` plus `init: true` on the compose service, and the same hand-test.

Also add `stop_grace_period: 30s` to the app service and ship `DRAIN_GRACE_MS` (default 10000) through the env allow-list.

`src/db/index.ts` needs a one-line change: it builds `const pool = new Pool(...)` and doesn't export it. Add `export { pool }`.

### 3. Migrations move off the serving container

Today `utils/deploy/hooks/post-deploy.sh` runs `docker exec ${CONTAINER_NAME} npx drizzle-kit migrate` **after** the container is already serving traffic. `docs/STATUS.md` names the consequence: *"there is a window where the new code is serving against the old schema: deploy the alternates code without 0003 and every save 500s."* That is a live bug today, independent of any of this.

Add a one-shot `migrate` service to the compose file, built on the same image, and run it **before** the app is recreated:

```yaml
  migrate:
    image: ${IMAGE_NAME}
    restart: "no"
    user: "${APP_UID}:${APP_GID}"
    environment:
      DATABASE_URL: postgresql://routeloop:${DB_PASSWORD}@db:5432/routeloop
    command: ["npx", "drizzle-kit", "migrate"]
    networks: [routeloop]
```

Invoked as `docker-compose run --rm --no-deps -T migrate`. It has no `container_name` because `run` generates its own.

`hooks/post-deploy.sh` is deleted and `POST_DEPLOY_HOOK` comes out of `deploy.config`. **Its long error message about baselining and about "a deploy whose schema step failed has not succeeded" must be carried over verbatim** into the new inline failure branch—that text is the record of a real outage (2026-08-03, when a non-fatal schema step let prod drift three sprints behind) and losing it in a refactor would be a genuine regression.

### 4. The new deploy sequence

Replacing lines ~323–329 of `deploy.sh`:

```bash
# db is converged, never torn down.
docker-compose up -d db
wait_for_db_healthy || exit 1

# Migrations BEFORE the new code serves anything.
docker-compose run --rm --no-deps -T migrate || exit 1

# --force-recreate because the image TAG is unchanged (routeloop:latest) and a
# Compose that decides the service is up-to-date would leave the old container
# in place and "deploy" nothing. --no-deps so this can never touch db.
docker-compose up -d --no-deps --force-recreate app

# Gate on /healthz reporting the SHA we just shipped.
gate_health "$GIT_SHA" || exit 1
```

The SHA assertion in the gate is the part that earns its keep. A `200` alone is not enough—a `up -d` that left the old container in place answers `200` with the *old* SHA and would sail through, which is exactly this project's recurring silent-success failure mode.

The current verify is `sleep 5` plus a **non-fatal** curl, which `deploy.config` and `docs/STATUS.md` both already flag as untrustworthy. It becomes a fatal, polled, SHA-asserting gate.

<!--| PAGE-BREAK -->

## Phase 2—blue/green behind Caddy

The topology after this change. The two host port numbers are frozen, because the Cloudflare tunnel config is managed remotely by whole-config PUT and nothing in this repo may require it to change:

```text
browser → CF edge → tunnel → cloudflared (native on NAS host)
                                  ↓
                    127.0.0.1:16703  ·  127.0.0.1:6686
                                  ↓
                          [ routeloop-proxy ]   ← the only published ports
                             ╱           ╲
              [routeloop-blue:6686]  [routeloop-green:6686]   ← no host ports
                             ╲           ╱
                              [ routeloop-db ]   ← never torn down
```

### Caddy over nginx, on four grounds

| | nginx | Caddy |
| --- | --- | --- |
| Graceful reload | Yes, `nginx -s reload` | Yes, `caddy reload` |
| **Request body limit** | **`client_max_body_size` defaults to 1MB.** The largest upload the app accepts is 10MB. Forgetting one line silently 413s every real GPX import | No default limit, streams by default |
| **`Host` header** | **Defaults to `$proxy_host`**—the app would see `Host: routeloop-blue`, breaking `LEGACY_HOSTS` and the alias 301 | Preserves the incoming `Host` for HTTP upstreams |
| Upstream DNS | Resolves once at config load; a literal upstream that doesn't resolve makes nginx **fail to start** | Re-resolves per dial |
| Config size | ~40 lines of boilerplate | ~12 lines |

The two middle rows decide it: both nginx defaults are *silent* failures in exactly the two areas this app cares about, imports and the canonical-host redirect. If you'd rather use nginx for familiarity, the plan is unchanged except the config file and the reload command.

### The config, and the swap

`proxy/Caddyfile` is committed and shipped every deploy. `proxy/upstream.caddy` is **not** in the repo—it is NAS state, one line, and it is the single source of truth for which color is live.

```caddyfile
{
  # `admin off` is tempting and WRONG: `caddy reload` goes through the admin API.
  # The default endpoint is localhost:2019 INSIDE the container, not published.
  auto_https off
}

:16703, :6686 {
  import /etc/caddy/upstream.caddy   # the one line the deploy rewrites
}
```

The cutover, validating before reloading so a bad config is caught with the old one still serving:

```bash
printf 'reverse_proxy %s:6686\n' "$NEXT_CONTAINER" > proxy/upstream.caddy
docker exec routeloop-proxy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec routeloop-proxy caddy reload   --config /etc/caddy/Caddyfile --adapter caddyfile
```

### Which color is live

Read `proxy/upstream.caddy`. That file *is* the answer—it is literally what the proxy is serving—so there is no second source of truth to drift.

Deliberately not used: `docker ps` (ambiguous by construction, since during overlap both colors run and the whole point is that "running" and "serving" are different states); the Caddy admin API (authoritative but returns adapted JSON, and grepping JSON in bash to make a cutover decision is how you cut over to the wrong container); a separate marker file (a second source of truth that can disagree with the first).

If the file is missing or unparseable, fall back to `docker ps`: exactly one color running means that's live, zero means pick blue, **two means abort** and print `deploy-utils.sh cutover blue|green`. Plus a `--color` override flag for when a human needs to force it.

### The volume guarantee—the one thing that can lose data

`deploy.sh` writes `COMPOSE_PROJECT_NAME=routeloop-prod` and the compose file declares a volume keyed `db-data`, so Docker addresses **`routeloop-prod_db-data`**. If that name or the volume block changes shape, Compose creates a *new empty* volume, Postgres initializes a fresh database into it, the container passes its healthcheck, and the deploy reports success. Silently. This is trap #2 in `docs/deployment.md` and it has already bitten this project.

Four guarantees, and the third is the one that actually makes it safe:

1. `COMPOSE_PROJECT_NAME` stays byte-identical at `routeloop-prod`.
2. The `db:` service block stays **byte-identical** to today's—not semantically equal, identical. Compose recreates a service whose definition hash changed, and while recreation on the same volume is survivable, it is avoidable risk on the one asset that is precious.
3. Pin the volume by name through a new `DB_VOLUME_NAME` allow-list key. **If the volume isn't there, Compose errors out instead of quietly creating one.** Silent loss becomes a loud failure.
4. `db-backup` before touching anything, and rehearse the whole thing on stage.

```yaml
volumes:
  db-data:
    # Pinned to the name the RUNNING prod volume already has. If Compose ever
    # wants a different one, THIS LINE makes it fail loudly instead of silently
    # creating an empty database.
    name: ${DB_VOLUME_NAME}
```

### Two YAML traps in the compose file

**Never run a bare `docker-compose up -d` in that directory**—it starts both colors. `deploy.sh` and `deploy-utils.sh` always name the service. Compose *profiles* would enforce this properly, but they need Compose ≥1.28 and `deploy.sh` invokes the hyphenated `/usr/local/bin/docker-compose`, which on Synology is frequently v1.x. **Action item before writing any of this: `ssh nas /usr/local/bin/docker-compose version`.** Until that is known the plan uses only flags that exist in both.

**Never `--remove-orphans`**—the pre-blue/green `routeloop` container is an orphan of this project by definition, and removing it is a decision, not a side effect.

**Do not use a YAML anchor to share config between the two colors.** `<<: *app` merges top-level keys only, so `environment:` in `app-green` *replaces* the anchored one wholesale and green would get `APP_COLOR` and nothing else. Given how long the env list is and how badly a missing `GOOGLE_CLIENT_SECRET` fails (silent, no sign-in at all), write both blocks out in full with a comment saying they must stay identical apart from `container_name` and `APP_COLOR`. Duplication a human can diff beats a merge rule that quietly drops keys.

### Rollback

The proxy is the **last** thing touched, and the old color is not stopped until after the origin verify passes. Everything before that point is a no-op on the live site.

| Failure point | Proxy touched | Site |
| --- | --- | --- |
| Build, transfer, `docker load` | no | never blinked |
| `up -d db proxy` | no | never blinked |
| Migrations fail | no | never blinked |
| **New color fails health gate** | **no** | **never blinked** |
| `caddy validate` or `reload` fails | no (Caddy keeps the old config) | never blinked |
| Origin verify shows wrong SHA | yes, then rolled back | one reload's worth |

There is no "roll back to the previous image" path and there shouldn't be one: rolling back is `git checkout <prev> && utils/deploy/prod.sh`, which goes through the same gated path. A second, less-tested rollback mechanism is how you get a rollback that doesn't work when you need it.

<!--| PAGE-BREAK -->

## The migration rule Phase 2 imposes

Moving migrations before the new color **closes** the "new code, old schema" window entirely. It **opens** a different one: from the moment `migrate` finishes until the old color stops, roughly 30–60 seconds, the **old code is serving against the new schema.**

> **Every migration must be runnable against the release that precedes it.** Expand/contract only. A rename is two deploys.

**Safe in one deploy:** add a nullable column or one with a default; add a table, an index, an enum value; widen a type; relax a constraint.

**Never safe in one deploy:** drop a column or table the previous release still writes; rename anything (Drizzle's differ emits a rename as `DROP` + `ADD`, which `AGENTS.md` already warns about for a different reason, and the old code's `INSERT` fails the instant the drop lands); `NOT NULL` without a default on a column the old code doesn't write; tighten a `CHECK` or add a `UNIQUE` the old code can violate.

A rename becomes: deploy 1 adds the new column, dual-writes both, backfills; deploy 2, after the old code is gone, drops the old one.

**What this actually costs here: close to nothing.** Across all eleven migrations in `drizzle/` there is **not one `DROP` and not one `RENAME`.** Nine are purely additive. Two tighten a column to `NOT NULL` (`0006` on `points.uid`, `0008` on `points.position`), which is the only shape that would have needed the two-step.

An escape hatch is worth having anyway: a `--no-overlap` flag on the deploy that falls back to stop-then-start for the rare migration that genuinely can't be made additive, so a breaking change is never blocked—it just costs one slow deploy.

### The ugly consequence to state out loud

**A failed health gate leaves the schema ahead of the serving code.** Migrations ran, the new color never took traffic, the old color is still live against a newer schema. That is survivable *exactly and only because of the expand/contract rule*, which is why it belongs in Prohibitions rather than as a guideline. `deploy.sh` must print it loudly on that path:

```text
The new color failed its health gate and the proxy was never touched — the site
is still serving <old-color> and never blinked.
BUT: migrations already ran. Production's schema is now AHEAD of the code
serving it. That is safe only if the migration was backward compatible.
```

### Where it gets written down

`AGENTS.md` → Prohibitions, directly under the existing "Read the generated SQL before applying a migration" bullet, which is its natural sibling. `docs/deployment.md` → the "Schema on deploy" section, with the mechanism and a worked rename example. `docs/database.md` → a pointer next to the baseline instructions.

<!--| PAGE-BREAK -->

## The sweeps need no change

Worth stating because the existing code comments predict a problem this design does not have.

**`startThumbnailSweep()`** does `setInterval(..., 5 * 60_000)` and **does not run a pass at boot**—its first pass is at T+5min, long after the ~15–40 second overlap window has closed. Its own docstring warns about "a doubled Google bill on the window where both replicas select the same ride", but that describes steady-state two-replica running, which this design never enters. **Update the comment to say so; change no code.**

**`startQuotaSweep()`** does run one pass at boot, so both colors can be inside `reconcileUsedBytes()` at once. But that is a single `UPDATE … WHERE u.used_bytes IS DISTINCT FROM t.total`. Two concurrent executions serialize on row locks and the loser finds nothing to do. Worst case is a spurious log line—and it happens while the new color is still being health-gated, before it takes any traffic.

**Rate limiting** doubles for the overlap. Meaningless: `src/auth/ratelimit.ts` is the cheap in-memory guard layered on top of the real one, which is the DB `login_tokens` row count in `src/auth/magic.ts`.

Explicitly **rejected**: an env gate like `SWEEPS_ENABLED=1` on one color. It requires the deploy to know which color is "primary"—durable state this design deliberately does not keep—and a rollback would silently turn the sweeps off. If you want belt-and-braces, `pg_try_advisory_lock` at the top of each sweep pass is about six lines each and no new dependency; hold it as a follow-up issue rather than bundling it here.

<!--| PAGE-BREAK -->

## The one-time NAS cutover

**This is the riskiest step and it is NOT zero downtime.** The old `routeloop` container holds both host ports and the proxy needs them; they cannot overlap. Expect **60–120 seconds**, once. Tell the three riders beforehand rather than after.

### Preconditions

Phase 1 and Phase 2 both run end to end **on stage, twice consecutively**, so that a blue→green→blue cycle is proven and not just the first cutover. `docker-compose version` on the NAS recorded. `caddy:2-alpine` present on the NAS. Explicit approval for a prod-touching change.

### Runbook

```bash
# 0. BACKUPS. Everything below is redoable except this step.
./utils/deploy/deploy-utils.sh db-backup
./utils/deploy/deploy-utils.sh backup
# A second copy that does not depend on this laptop:
ssh nas 'docker exec routeloop-db pg_dump -U routeloop -d routeloop | gzip \
  > /volume1/web/_backups/routeloop-pre-bluegreen-$(date +%Y%m%d-%H%M%S).sql.gz'
gunzip -c routeloop-db-*.sql.gz | grep -c 'CREATE TABLE'   # not empty
```

```bash
# 1. GROUND TRUTH ABOUT THE VOLUME. Do not skip.
ssh nas '
  docker volume ls | grep -i db-data
  docker inspect routeloop-db --format "{{json .Mounts}}"
  grep COMPOSE_PROJECT_NAME /volume1/web/routeloop.app/.env
'
```

Expect `routeloop-prod_db-data` and `COMPOSE_PROJECT_NAME=routeloop-prod`. **If the running container is mounted on anything else—which `docs/STATUS.md` documents having happened locally—STOP.** Set `DB_VOLUME_NAME` to what the *running container* actually uses, not what Compose would want. Getting this wrong is the difference between "the database is fine" and "the database is empty and looks fine".

```bash
# 2. ESCAPE HATCH
ssh nas 'cd /volume1/web/routeloop.app && cp docker-compose.yml docker-compose.yml.pre-bluegreen && cp .env .env.pre-bluegreen'
```

```bash
# 3. FREE THE HOST PORTS — the only step with downtime. Clock starts here.
#    `docker stop` + `rm` of the APP CONTAINER ONLY. NOT `docker-compose down`,
#    which takes db and the network with it.
ssh nas 'docker stop routeloop && docker rm routeloop && docker ps'   # db STILL RUNNING
```

```bash
# 4. DEPLOY THE NEW TOPOLOGY
./utils/deploy/prod.sh
```

Watch for, in order: `up -d db proxy` reporting db as **up-to-date**, not `Recreating`; the proxy starting; the one-shot migrator applying `0002`–`0010`; `routeloop-blue` passing its health gate on the new SHA; the origin verify on **both** ports. **If db says `Recreating`, that is the abort signal**—the db block is not byte-identical, and you want to know why before finding out the hard way.

```bash
# 5. VERIFY BY HAND, NOT BY SCRIPT
./utils/deploy/deploy-utils.sh colors
./utils/deploy/deploy-utils.sh status
ssh nas 'docker volume ls'          # NO new db volume appeared
```

Then in a browser: sign in (proves the session cookie and `Host` survive the proxy hop); load a ride's map (proves `data/storage` is still bound and readable as `1026:100`); download a KML; import a GPX just under the 10MB per-file cap (proves no body-size cap—see the correction under Verification; there is no 25MB upload ceiling); hit `tankbag.app` and confirm the 301 (proves `LEGACY_HOSTS` sees the real host); check the footer shows the expected `APP_VERSION`.

```bash
# 6. ROLLBACK if any of step 5 fails — back on the old topology in ~60s.
ssh nas '
  cd /volume1/web/routeloop.app
  docker-compose stop proxy app-blue || true
  docker rm -f routeloop-proxy routeloop-blue || true
  cp docker-compose.yml.pre-bluegreen docker-compose.yml && cp .env.pre-bluegreen .env
  docker-compose up -d app
'
```

**db never moved and `data/storage` never moved**, which is what makes this rollback cheap. The one thing that does not roll back is the schema, which is why every migration in the batch must be checked for backward compatibility *before* step 3—and `0002`–`0010` have never run anywhere but a dev machine, so this is not hypothetical.

```bash
# 7. LEAVE THINGS ALONE FOR A WEEK.
#    No `docker volume prune`, no `image prune`, do not delete the .pre-bluegreen
#    files. The old image and any orphan volume are the last line of defense.
```

**Cloudflare: nothing changes.** The tunnel still points at `127.0.0.1:16703` and `127.0.0.1:6686`; the only difference is what is listening. No whole-config PUT, no DNS change, no Access change. That is the entire reason the proxy binds those exact two ports.

<!--| PAGE-BREAK -->

## Ops commands

`deploy-utils.sh` currently assumes a single `${CONTAINER_NAME}` throughout, and `restart` / `stop` / `start` are all whole-stack. Factor the SSH plumbing and the color resolution into `utils/deploy/lib.sh` sourced by both scripts—they already duplicate `check_ssh_key` and `get_ssh_cmd` verbatim.

| Command | Becomes |
| --- | --- |
| `logs` | `logs [blue\|green\|proxy\|db]`, defaulting to the **live** color and printing which it chose. A `logs` that silently follows an idle container is worse than an error |
| `status` | A table of all four services, which color the proxy says is live, `/healthz` through both host ports with version and build parsed out, plus a direct `/healthz` against each running color—which is how you spot "green is healthy but nothing points at it" |
| `restart` | Restarts **the live color in place**, and says out loud that this is brief downtime and `prod.sh` is the zero-downtime path. New `restart-proxy` is a `caddy reload`; new `restart-db` is separate and needs a typed confirmation |
| `stop` | Stops the colors and the proxy, **leaving db up**. `stop --all` adds db and requires typing the environment name |
| `start` | `up -d db proxy`, wait for healthy, then `up -d --no-deps app-<color from upstream.caddy>`. Never a bare `up -d` |
| `migrate` | `docker-compose run --rm --no-deps -T migrate`, a one-shot on the loaded image rather than a `docker exec` into whichever color happens to be up |
| `db-baseline` | Same one-shot with the command overridden. The error text in `post-deploy.sh` that tells you to run this must be updated |
| `db-backup`, `backup`, `psql`, `db-clone`, `db-restore` | Unchanged—all address `DB_CONTAINER_NAME` or the storage path, neither of which moves |
| **new** `colors` | Live / idle / what is actually running. The first thing to type when something looks wrong |
| **new** `cutover blue\|green` | The manual lever. Rewrite, validate, reload, verify. Refuses if the target isn't running and healthy. This is how you roll back by hand in ten seconds while the old color is still up |

<!--| PAGE-BREAK -->

## Verification

### What gets a Vitest test

`test/health.test.ts` over the pure `health()` function: healthy → 200 and `ok:true`; `dbUp:false` → 503; `draining:true` → 503 even when the DB is up; the body carries version and build verbatim. That is genuinely the whole list, and that is correct—`vitest.config.ts` is scoped to pure logic and `utils/` isn't even in `tsconfig`.

Specifically **not** proposed: a Vitest test for the color picker. That logic lives in bash under `utils/deploy/`, outside both scopes, and porting it into `src/` so it could be tested would put deploy logic into the application image to satisfy a test. What actually protects it is the origin verify asserting the served `BUILD_SHA`, which catches a wrong-color cutover in production where the bug would matter.

### What must be verified by hand on stage, before prod

1. **Two consecutive deploys**, blue→green→blue. One doesn't prove the color flips back.
2. **Zero dropped requests, measured.** From the NAS host during a deploy: `while true; do curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:6687/healthz; sleep 0.2; done | sort | uniq -c`. Anything that isn't `200` is the thing this plan exists to eliminate.
3. **SIGTERM actually reaches Node.** The PID-1 problem. Single most likely thing to be silently broken.
4. **A deliberately broken build rolls back cleanly.** Ship a commit that throws on boot. Confirm the proxy is never touched, the old color keeps serving, and the failure output names the container and dumps its logs.
5. **A real GPX/KML import through the proxy**, as large as the app will take—the nginx body-limit trap in reverse. **Corrected 2026-08-27: there is no 25MB upload ceiling**, which is what this line used to claim. 25MB is the STORAGE QUOTA. The upload caps are 10MB per GPX/KMZ/GeoJSON and 5MB per KML (`src/maps/kml.ts`), behind a 16MB multipart backstop (`src/routes/maps.ts`). A file over those is refused by the app with `{"error":"upload too large"}` before its size ever reaches the proxy, so testing with one proves nothing about the proxy at all—measured, by doing exactly that.
6. **Sign in through the proxy**, both Google OAuth and the magic link. Proves `Host`, the cookie `Secure` flag, `APP_ORIGIN`, and the OAuth redirect URI all survive the extra hop.
7. **The alias 301** through the proxy.
8. **A ride's map and a file download**, proving `data/storage` is still bound and readable from a container whose name changed.
9. **`docker volume ls` before and after.**
10. **`deploy-utils.sh cutover <old-color>` by hand** right after a successful deploy. The emergency lever must be known to work before it's needed.
11. **`npm run typecheck`** on the `serve() as HttpServer` narrowing.

Plus the standing rule: anything touching the map, the builder, or an import needs a manual browser pass regardless, and items 5, 6, and 8 are exactly that.

<!--| PAGE-BREAK -->

## Files

**Changed:** `utils/deploy/deploy.sh`, `utils/deploy/deploy-utils.sh`, `deploy.config`, `docker-compose.prod.yml`, `Dockerfile`, `src/index.tsx`, `src/db/index.ts`.

**New:** `src/health.ts`, `src/shutdown.ts`, `test/health.test.ts`, `proxy/Caddyfile` (Phase 2), `utils/deploy/lib.sh` (Phase 2).

**Deleted:** `utils/deploy/hooks/post-deploy.sh`, with its error text carried into `deploy.sh` verbatim.

### New env allow-list keys

Per trap #4 in `docs/deployment.md`, **a key not on this list reaches no environment** and the container still starts and passes its healthcheck:

```text
DRAIN_GRACE_MS         # Phase 1
DB_VOLUME_NAME         # Phase 2 — the volume-adoption guarantee
BLUE_CONTAINER_NAME    # Phase 2
GREEN_CONTAINER_NAME   # Phase 2
PROXY_CONTAINER_NAME   # Phase 2
PROXY_IMAGE            # Phase 2
```

### Documentation

`docs/deployment.md` gets the largest edit: the proxy hop in the topology diagram, a new blue/green section, a rewritten "Schema on deploy", three new traps (the proxy owns the host ports; a failed health gate leaves the schema ahead; never a bare `up -d` and never `--remove-orphans`), and updates to traps #2 and #4. The traps section is titled "all of which have actually happened", so new entries must be marked *predicted, not yet observed* or the heading becomes a lie.

`AGENTS.md` gets the expand/contract prohibition, the proxy and colors in Architecture, and two gotchas: the `Host`-header dependency, and that graceful shutdown is only real if SIGTERM actually reaches Node.

`docs/STATUS.md` must **correct** the existing paragraph reading *"That hook runs after the new container passes its healthcheck, so there is a window where the new code is serving against the old schema"*—false the moment this ships, and STATUS.md's own rule is that a document disagreeing with the code loses.

**No new `docs/blue-green.md`.** A separate file is a file that drifts.

**One GitHub issue, filed after the fact and closed in the same breath**, per the rule in `AGENTS.md`. Label `area:ops`. One issue for the whole coherent unit, not one per phase. The body records the *decisions*: Caddy over nginx and why, migrations before the new color rather than after, expand/contract as a hard rule, no sweep changes and why, and the volume-adoption guarantee. Follow-ups worth filing separately: an advisory-lock migrator, advisory locks on the sweeps, and the `tsx`-at-boot transpile cost.

<!--| PAGE-BREAK -->

## Open calls for you

**Three of the six are answered, 2026-08-27**, and are struck through rather than deleted so the reasoning stays readable.

1. ~~**Phase 1 only, Phase 1 then Phase 2, or both at once?**~~ **Phase 1 only, for now.** Stopping after it leaves a much better deploy and nothing half-finished; Phase 2 stays available and every piece of Phase 1 is a prerequisite for it either way.
2. *(Phase 2)* **Caddy confirmed?** You picked it already; noting it here because it is a new prod dependency and `AGENTS.md` requires explicit approval.
3. *(Phase 2)* **Expand/contract with a `--no-overlap` escape hatch, or strict?** I lean escape hatch—it costs one code path and means a genuine emergency is never blocked.
4. ~~**`/healthz` public with `BUILD_SHA` in it, or hidden behind the proxy?**~~ **Public, with the SHA in it.** It is already in a `title` attribute on every page and in the feedback diagnostics, so this puts nothing new in reach; what it buys is a gate the deploy can reach directly rather than over SSH into the host.
5. *(Phase 2)* **`DB_VOLUME_NAME` hard-pinned per environment, or parameterized as `${COMPOSE_PROJECT_NAME}_db-data`?** I lean hard-pinned—the parameterized form turns a typo into a wrong-but-loud volume, but it does not actually *pin* anything, and this is the one failure mode that has already happened twice here.
6. ~~**Advisory-lock migrator now or later?**~~ **Later, as its own issue.** `drizzle-kit migrate` stays, run as a one-shot container. Replacing `drizzle-kit migrate` with a programmatic `migrate()` wrapper would drop `drizzle-kit` from the runtime path, but it also replaces a load-bearing path that has already burned this project once, and adding that risk to the riskiest change in months is bad sequencing.
