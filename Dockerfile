# syntax=docker/dockerfile:1
# routeloop — Node + Hono app image. Built on Apple Silicon for linux/amd64 (NAS).
# Node 24, the active LTS. Bumped from 22 on 2026-08-16 alongside the CI
# matrix and package.json's `engines` — the three move together, or the matrix
# stops testing what actually ships. This takes effect on the next deploy.
FROM node:24-alpine

# WHAT LINKS THE GHCR PACKAGE TO THIS REPOSITORY. Without it a package pushed by
# a personal token is USER-scoped and unlinked, and a workflow's GITHUB_TOKEN —
# which only ever gets write access to packages the repository owns or has been
# explicitly granted — is refused with `denied: permission_denied: write_package`
# after a full build. Granting an existing unlinked package to the repo is a
# UI-only setting (Package settings, Manage Actions access); this label is what
# stops the next package needing that step at all.
LABEL org.opencontainers.image.source="https://github.com/feralcreative/routeloop"

WORKDIR /app

# All deps, not --omit=dev, on purpose: the runtime entrypoint is `tsx` and the
# post-deploy migration step is `drizzle-kit` — both are devDependencies.
COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY tsconfig.json drizzle.config.ts ./
# drizzle/ holds the generated migrations and their journal. The post-deploy
# hook runs `drizzle-kit migrate` inside this container, so without this COPY it
# finds no migrations, applies nothing, and reports success — the exact silent
# drift the hook was made fatal to prevent.
COPY drizzle ./drizzle
# utils/ comes along for utils/db-baseline.ts, which has to run once inside a
# container whose database predates drizzle/. It computes migration hashes with
# drizzle's own readMigrationFiles, so it cannot be replaced by hand-written SQL
# without risking a hash that migrate() disagrees with.
COPY utils ./utils
COPY src ./src
COPY public ./public
COPY style ./style

# public/style/main.min.css is gitignored (a build artifact), so it is compiled
# here rather than copied in. Without this the deployed site has no stylesheet.
RUN npm run sass

# User KML/GPX files live on a mounted volume, never baked into the image.
RUN mkdir -p /app/storage && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    PORT=6686 \
    STORAGE_PATH=/app/storage

EXPOSE 6686

# /healthz, not `/`. The old target rendered the public map list on every probe
# — a visibility query, a session lookup and a full JSX render, every thirty
# seconds forever — to answer a question none of that work was about. See the
# header of src/health.ts.
#
# --spider is a HEAD-ish request and wget exits non-zero on a 503, which is what
# makes a draining container fail its own healthcheck: exactly the signal
# wanted, since a container on its way out should not be reported healthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:6686/healthz || exit 1

# NODE IS PID 1, AND THIS LINE IS LOAD-BEARING FOR THE GRACEFUL SHUTDOWN.
#
# This was `CMD ["npm", "run", "start"]`, which makes **npm** PID 1 with node as
# its child. npm's signal forwarding to that child is historically unreliable,
# and there was a second hop through the `tsx` shim besides. If SIGTERM does not
# reach the Node process then the handler in src/shutdown.ts is dead code and
# every deploy still hard-kills whatever was in flight — while every log line
# says the deploy worked. That is the failure mode this project keeps hitting,
# so the fix is to leave no forwarder in the path at all.
#
# `node --import tsx` is supported by tsx ^4.19.2, which is what package.json
# pins. VERIFY BY HAND ON STAGE RATHER THAN ASSUMING: `docker stop <container>`,
# then confirm `[shutdown] SIGTERM received, draining` appears in `docker logs`
# AND that the container exits in about a second instead of taking the full
# ten-second SIGKILL timeout. A fast exit with no log line means the signal is
# being swallowed somewhere; the fallback is
# `CMD ["./node_modules/.bin/tsx", "src/index.tsx"]` with `init: true` on the
# compose service, and the same hand-test.
CMD ["node", "--import", "tsx", "src/index.tsx"]
