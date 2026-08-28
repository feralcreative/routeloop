// What the deploy asks the container, and the only answer it trusts.
//
// SPLIT RULE-FROM-QUERY, the same arrangement as thumbnail.ts against
// thumbnail-sweep.ts: `health()` is a pure function of what it is handed, so
// `test/health.test.ts` covers every state with no database and no server. The
// probing lives in `index.tsx`, which is the only part that needs either.
//
// WHY NOT KEEP PROBING `/`. That is what the Dockerfile did until now, and its
// comment justified it — "renders the public map list, so it exercises the DB
// connection too". It does, and it also renders the full page, runs the
// visibility query and takes a session lookup, every thirty seconds forever, to
// answer a question none of that work is about. Worse, it cannot answer the
// question the deploy actually needs, which is not "are you up" but **"are you
// the build I just shipped"**.
//
// THAT SECOND QUESTION IS THE WHOLE POINT. This project's recurring failure is
// the silent success: a step that reports 200 while having done nothing. A
// `docker-compose up -d` that decides the service is already up-to-date leaves
// the OLD container running, and the old container answers a plain health probe
// exactly as happily as a new one would. Returning `build` lets the deploy
// assert the SHA it just pushed and fail when it does not match, which is the
// difference between a verified deploy and a hopeful one.
//
// PUBLIC, WITH THE SHA IN IT. Ziad's call, 2026-08-27. `src/version.ts` keeps
// BUILD_SHA off the rider-facing version label deliberately, but it already
// rides in a `title` attribute on every page and in the feedback diagnostics, so
// this puts nothing new in reach of anyone. What it buys is a gate the deploy
// script can reach directly rather than over SSH into the host.

/** Everything the answer depends on, passed in so nothing here reads a global. */
export type HealthInput = {
  version: string
  build: string
  /** Blank on every environment until Phase 2 gives the containers colors. */
  color: string
  dbUp: boolean
  /** True once SIGTERM has been received — see src/shutdown.ts. */
  draining: boolean
  uptimeSec: number
}

export type HealthOut = {
  status: 200 | 503
  body: {
    ok: boolean
    version: string
    build: string
    color: string
    db: 'up' | 'down'
    draining: boolean
    uptime: number
  }
}

/**
 * DRAINING IS A 503 WHILE THE PROCESS IS STILL ANSWERING REQUESTS, and that is
 * the point of it rather than a contradiction. A container that has been told to
 * stop must finish the requests it already has and be given no new ones, so it
 * has to stay up and say "do not send me anything" at the same time. A proxy
 * reads the 503 and takes it out of rotation; the in-flight responses complete
 * on the connections that already exist.
 *
 * `db: 'down'` is also a 503 even though most pages would still render, because
 * a container that cannot reach Postgres cannot serve a signed-in rider at all —
 * every page takes a session lookup. Reporting healthy would hold the deploy
 * gate open on a container that is useless.
 */
export function health(i: HealthInput): HealthOut {
  const ok = i.dbUp && !i.draining
  return {
    status: ok ? 200 : 503,
    body: {
      ok,
      version: i.version,
      build: i.build,
      color: i.color,
      db: i.dbUp ? 'up' : 'down',
      draining: i.draining,
      // Whole seconds: this is read by a person tailing a deploy, and the
      // fractional part of an uptime has never told anybody anything.
      uptime: Math.floor(i.uptimeSec),
    },
  }
}
