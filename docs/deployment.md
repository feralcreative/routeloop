# Deployment

Never deploy without being asked. Deploys go to a live site riders have accounts on.

## Topology

Synology NAS running Docker, behind Cloudflare Tunnel; HTTPS terminates at the edge. `deploy.config` is committed and holds no secrets—read it rather than this file for the current names and ports.

The app always listens on 6686 *inside* the container. Each container publishes **two** host ports and answers on both, which is what let the canonical name change without touching tunnel config: the alias hostname 301s to the canonical one in app code.

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

`utils/deploy/deploy-utils.sh` carries the operational subcommands: `status`, `logs`, `db-logs`, `restart`, `stop`, `start`, `shell`, `psql`, `migrate`, `db-baseline`, `db-backup`, `backup`, `db-clone <src> <dst>`, `db-restore`. `db-clone`'s dump-and-load path has never actually been exercised end to end.

## Schema on deploy

`utils/deploy/hooks/post-deploy.sh` runs `npx drizzle-kit migrate` inside the container and is **fatal on failure**. A non-fatal schema step is how production once drifted three sprints behind and started serving 500s while the deploy reported success. Do not reintroduce that, and do not reintroduce `--force`.

The image must carry `drizzle/`—see the `COPY drizzle ./drizzle` line in the `Dockerfile`. Without it `migrate` finds no migrations, applies nothing and exits 0, which is the same silent drift in a new costume.

A database built under the old `drizzle-kit push` workflow needs a one-time baseline before its first `migrate`. Order and hazards are in [database.md](database.md).

## Traps, all of which have actually happened

- **The old stack holds the ports.** A renamed stack wants the same host ports the previous one published, and Compose fails with `port is already allocated` and nothing more helpful. Bring the old stack down first.
- **A stale volume gets adopted silently.** Volumes are namespaced by `COMPOSE_PROJECT_NAME`, not by the deploy directory, so a "fresh" deploy can come up on a months-old pre-pivot schema. The symptom is a healthy container that 500s on sign-in with `column users.username does not exist`. Run `docker volume ls` before assuming an environment is empty; `docker compose down -v` and re-run the post-deploy hook to fix it. `docker-compose.yml` pins `name: routeloop` for the same reason locally—renaming the checkout otherwise orphans the data volume.
- **The deploy ships only an explicit allow-list of env vars.** `GMAPS_MAP_ID`, `GOOGLE_CLIENT_*` and the `SMTP_*` set were once shipped nowhere: the container starts, passes its healthcheck, and is useless—no markers, and *neither sign-in method exists*, because both hide themselves when unconfigured. `deploy.sh` now hard-fails on the ones that matter. **A new required key must be added to that list**, or it reaches no environment.
- **The NAS deploy path is derived from `$DOMAIN`.** It changed with the rename, and deploying without first moving the directory on the NAS creates a second one rather than updating the first.

## Storage and data

Imported originals live under the environment's `data/storage` on the NAS, and in `storage/` locally. They are not in git and are not rebuildable from anything else. `db-clone` moves both the database and storage together for that reason.
