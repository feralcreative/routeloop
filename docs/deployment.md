# Deployment

Never deploy without being asked. Deploys go to a live site riders have accounts on.

## Topology

Synology NAS running Docker, behind Cloudflare Tunnel; HTTPS terminates at the edge. `deploy.config` is committed and holds no secrets—read it rather than this file for the current names and ports.

The app always listens on 6686 *inside* the container. **A proxy publishes the two host ports and the app containers publish none**, which is what makes a deploy zero-downtime: the containers are replaced behind a listener that never restarts. Both host ports answer identically, which is what let the canonical name change without touching tunnel config: the alias hostname 301s to the canonical one in app code.

```text
browser → CF edge → tunnel → cloudflared (native on the NAS host)
                                  ↓
                    127.0.0.1:16703  ·  127.0.0.1:6686
                                  ↓
                          [ routeloop-proxy ]   ← the only published ports
                             ╱           ╲
              [routeloop-blue:6686]  [routeloop-green:6686]   ← no host ports
                             ╲           ╱
                              [ routeloop-db ]   ← never torn down
```

```text
routeloop.app          → localhost:16703  (canonical, prod)
tankbag.app            → localhost:6686   (same container, 301s away)
stage.routeloop.app    → localhost:6687   (canonical, stage)
stage.tankbag.app      → localhost:16687  (same container, 301s away)
```

`www.routeloop.app` has a DNS record but no tunnel route, so it returns a bare Cloudflare 404. The app already 301s `www` to the apex in `LEGACY_HOSTS`; it just never receives the request.

## Running a deploy

```bash
utils/deploy/prod.sh  --dry-run     # preview
utils/deploy/stage.sh               # stage
utils/deploy/prod.sh                # prod
```

Both wrappers set `DEPLOY_ENV` and exec `utils/deploy/deploy.sh`, which gates on a clean tree and being on `main` unless `--force`.

`utils/deploy/deploy-utils.sh` carries the operational subcommands: `colors`, `cutover`, `status`, `logs`, `db-logs`, `restart`, `restart-proxy`, `restart-db`, `stop`, `start`, `shell`, `psql`, `migrate`, `schema-state`, `db-baseline`, `db-backup`, `backup`, `db-clone <src> <dst>`, `db-restore`. `db-clone`'s dump-and-load path has never actually been exercised end to end.

`utils/deploy/pull-db.sh` is the one-command form of the case that comes up most, refreshing local from production:

```bash
utils/deploy/pull-db.sh                 # prod → dev, database + storage
utils/deploy/pull-db.sh --from stage    # stage → dev
utils/deploy/pull-db.sh --no-storage    # database only
utils/deploy/pull-db.sh --no-migrate    # keep the remote schema as it actually is
```

It is a wrapper: `db-clone <src> dev` does everything destructive, including the safety dump of the local database and the typed confirmation. What the wrapper adds is the step on each side that was easy to forget—bringing the local Postgres container up first, and running `npm run db:migrate` afterwards. That second one is not cosmetic: prod and stage are **behind** local on migrations, so the dump restores an older schema over a newer one and the app 500s on save until they are reapplied.

## Blue/green

Two app containers, one live at a time, behind Caddy. A deploy brings up whichever color is **not** serving, health-gates it on the SHA it just pushed, points the proxy at it, verifies the origin, and only then drains the old one.

**`proxy/upstream.caddy` on the NAS is the single source of truth for which color is live.** One line, gitignored, and it is literally what Caddy is reading—so there is no second answer that can drift. `live_color()` in `utils/deploy/lib.sh` is the only implementation. `docker ps` is deliberately not used: during a cutover both colors run, and the entire point of the design is that "running" and "serving" are different states.

```bash
utils/deploy/deploy-utils.sh colors           # live, idle, what is running
utils/deploy/deploy-utils.sh cutover green    # the manual rollback lever
```

**The old color is drained and stopped once the origin verify passes**, not left warm—two live app containers is memory spent on nothing, and the next deploy force-recreates the idle one regardless. Rolling back by hand is therefore two commands, `up -d --no-deps app-<color>` then `cutover <color>`, and the deploy prints both when it finishes. **`cutover` refuses a color that is not running or not healthy**, which is the point: pointing the proxy at a dead container is a 502 for every rider, and a human reaches for this command when something is already wrong.

During the deploy itself the old color IS still up, which is what makes the automatic rollback on a failed origin verify instant. There is deliberately no "roll back to the previous image" path—rolling back is `git checkout <prev> && utils/deploy/prod.sh`, through the same gated route. A second, less-tested rollback mechanism is how you end up with a rollback that does not work when you need it.

Everything before the cutover is a no-op on the live site:

| Failure point | Proxy touched | Site |
| --- | --- | --- |
| Build, transfer, `docker load` | no | never blinked |
| `up -d db proxy` | no | never blinked |
| Migrations fail | no | never blinked |
| **New color fails its health gate** | **no** | **never blinked** |
| `caddy validate` or `reload` fails | no—Caddy keeps its running config | never blinked |
| Origin verify shows the wrong SHA | yes, then rolled back automatically | one reload's worth |

**Caddy rather than nginx**, on two grounds that are both *silent* failures in exactly the areas this app cares about: nginx's `client_max_body_size` defaults to 1MB against a 10MB per-GPX cap, so every real import would 413; and nginx sets the upstream's `Host` by default, so the app would see `Host: routeloop-blue` and both `LEGACY_HOSTS` and the alias 301 would break.

## Schema on deploy

`deploy.sh` runs `npx drizzle-kit migrate` as a **one-shot `migrate` service**, built on the same image, **before the app container is recreated**—and it is **fatal on failure**. A non-fatal schema step is how production once drifted three sprints behind and started serving 500s while the deploy reported success. Do not reintroduce that, and do not reintroduce `--force`. It ran as a post-deploy hook via `docker exec` into the serving container until 2026-08-27; the problem was never the hook but the ordering, which left every migration-carrying deploy serving new code against the old schema.

The image must carry `drizzle/`—see the `COPY drizzle ./drizzle` line in the `Dockerfile`. Without it `migrate` finds no migrations, applies nothing and exits 0, which is the same silent drift in a new costume.

A database built under the old `drizzle-kit push` workflow needs a one-time baseline before its first `migrate`. Order and hazards are in [database.md](database.md). **Look before you choose**: `deploy-utils.sh schema-state` distinguishes a stale adopted volume from a genuinely unbaselined database, and baselining the first destroys it.

**Every migration must be runnable against the release that precedes it.** Blue/green means that from the moment `migrate` finishes until the old color drains—roughly 30–60 seconds—the *old code is serving against the new schema*. Expand/contract only; a rename is two deploys. The full rule, with what is and is not safe in one deploy, is in `AGENTS.md` under Prohibitions. `utils/deploy/prod.sh --no-overlap` is the escape hatch for a migration that genuinely cannot be split, and it stops the old color first, so that deploy **has downtime**.

The ugly consequence, stated rather than discovered: **a failed health gate leaves the schema ahead of the serving code.** Migrations ran, the new color never took traffic, the old color is still live against a newer schema. That is survivable exactly and only because of the expand/contract rule, and `deploy.sh` prints it loudly on that path.

## Traps, all of which have actually happened

- **The old stack holds the ports.** A renamed stack wants the same host ports the previous one published, and Compose fails with `port is already allocated` and nothing more helpful. Bring the old stack down first. **Hit again on 2026-08-27**, in its worst form: a `tankbag-stage` container from before the rename had been holding both stage ports for eighteen days, so every stage deploy in that window failed to bind—and the old `docker-compose down` never freed them, because it only ever addressed the `routeloop-stage` compose project. An orphan of a *different* project is invisible to every command the deploy runs.
- **The proxy owns the host ports now, so a stray container holding one is fatal to the whole environment rather than to one color.** Same symptom, one level up.
- **`upstream.caddy` must exist as a FILE before the proxy starts.** *Predicted, not yet observed.* Compose bind-mounts it; if the path is absent on the host, Docker creates a **directory** there and Caddy fails to read its own config with an error that mentions nothing about mounts. `deploy.sh` seeds it before bringing the proxy up for exactly this reason.
- **Never a bare `docker-compose up -d` in the deploy directory, and never `--remove-orphans`.** *Predicted, not yet observed.* The first would start both colors; they sit behind Compose profiles so it currently cannot, and naming a profiled service explicitly still starts it. The second would remove the pre-blue/green `routeloop` container, which is an orphan of this project by definition—that is a decision somebody makes on purpose, not a side effect of a flag.
- **A stale volume gets adopted silently.** Volumes are namespaced by `COMPOSE_PROJECT_NAME`, not by the deploy directory, so a "fresh" deploy can come up on a months-old pre-pivot schema. The symptom is a healthy container that 500s on sign-in with `column users.username does not exist`. Run `docker volume ls` before assuming an environment is empty; `docker compose down -v` and re-run the deploy to fix it. `docker-compose.yml` pins `name: routeloop` for the same reason locally—renaming the checkout otherwise orphans the data volume.
- **The build's version is computed from the commit, and the deploy prints it.** `APP_VERSION` is `YYYY-MM-DD-HHMMPT`, the minute of HEAD's committer date in Pacific; the banner shows it next to the git SHA before it asks for confirmation. Use that string as the heading when you add the matching entry to `src/content/release-notes.html`, so a rider reading the footer can find it.
- **The deploy ships only an explicit allow-list of env vars.** `GMAPS_MAP_ID`, `GOOGLE_CLIENT_*` and the `SMTP_*` set were once shipped nowhere: the container starts, passes its healthcheck, and is useless—no markers, and *neither sign-in method exists*, because both hide themselves when unconfigured. `deploy.sh` now hard-fails on the ones that matter. **A new required key must be added to that list**, or it reaches no environment.
- **The NAS deploy path is derived from `$DOMAIN`.** It changed with the rename, and deploying without first moving the directory on the NAS creates a second one rather than updating the first.

## Storage and data

Imported originals live under the environment's `data/storage` on the NAS, and in `storage/` locally. They are not in git and are not rebuildable from anything else. `db-clone` moves both the database and storage together for that reason.
