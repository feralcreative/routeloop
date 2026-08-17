# syntax=docker/dockerfile:1
# routeloop — Node + Hono app image. Built on Apple Silicon for linux/amd64 (NAS).
# Node 24, the active LTS. Bumped from 22 on 2026-08-16 alongside the CI
# matrix and package.json's `engines` — the three move together, or the matrix
# stops testing what actually ships. This takes effect on the next deploy.
FROM node:24-alpine

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

# `/` renders the public map list, so it exercises the DB connection too.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:6686/ || exit 1

CMD ["npm", "run", "start"]
