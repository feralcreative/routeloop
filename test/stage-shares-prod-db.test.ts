// STAGE RUNS ON PRODUCTION'S DATABASE (#305, 2026-09-09), and these are the
// invariants that keep that survivable. Every one of them lives in a file no
// other test can reach: two shell scripts, a compose file, and one string of
// rider-facing copy.
//
// TEXT AND NOT BEHAVIOR, for the reason test/calendar-day-copy.test.ts and
// test/map-globals.test.ts give: `vitest.config.ts` is scoped to pure logic, CI
// runs no Postgres and no Docker, so the only place a compose file or a deploy
// script can be checked for free is in the source. The alternative is finding
// out on the NAS, and the thing on the NAS is now production's data.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

const compose = read('docker-compose.prod.yml')
const deployConfig = read('deploy.config')
const deploySh = read('utils/deploy/deploy.sh')

// Comments in these files argue about the very strings being matched — the
// compose file explains at length why there is no `depends_on` any more — so a
// scanner that did not strip them would pass on the explanation and never look
// at the code. Same trap test/content.test.ts records.
const stripHash = (s: string) =>
  s
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')

describe('the stage project cannot destroy the production volume', () => {
  // THE SHARPEST EDGE IN THE WHOLE CHANGE. `docker-compose down -v` removes the
  // volumes the project DECLARES, and both environments are deployed from this
  // one compose file — so if stage's DB_VOLUME_NAME ever resolved to prod's, a
  // `down -v` typed in the stage deploy directory would take production's
  // database with it. Nothing else in the repo would notice.
  it('gives stage a volume name of its own, never production’s', () => {
    const prod = /^PROD_DB_VOLUME_NAME="([^"]+)"/m.exec(deployConfig)?.[1]
    const stage = /^STAGE_DB_VOLUME_NAME="([^"]+)"/m.exec(deployConfig)?.[1]
    expect(prod).toBeTruthy()
    expect(stage).toBeTruthy()
    expect(stage).not.toBe(prod)
  })

  // The names are pinned rather than merely different, because "different" is
  // also satisfied by a typo, and a typo here is how this project has already
  // once come up on a confident, wrong, empty volume.
  it('pins both names to the volumes that actually exist', () => {
    expect(deployConfig).toContain('PROD_DB_VOLUME_NAME="routeloop-prod_db-data"')
    expect(deployConfig).toContain('STAGE_DB_VOLUME_NAME="routeloop-stage_db-data"')
  })
})

describe('no compose service depends on a database stage does not run', () => {
  // A `depends_on: db` is what would quietly start a SECOND Postgres in the
  // stage project — on stage's own dead volume, so the app would come up on an
  // empty database that passes every healthcheck and shows no rides. The NAS is
  // on Compose v2.20, where the interaction between depends_on and an inactive
  // profile is not a thing to find out about in production.
  it('has no depends_on left in the compose file', () => {
    expect(stripHash(compose)).not.toMatch(/depends_on:/)
  })
})

describe('both environments are parameterized rather than hardcoded to prod', () => {
  const code = stripHash(compose)

  it('routes every DATABASE_URL through DB_HOST', () => {
    const urls = code.match(/DATABASE_URL: \S+/g) ?? []
    // Three: the two colors and the one-shot migrator.
    expect(urls).toHaveLength(3)
    for (const u of urls) expect(u).toContain('${DB_HOST:-db}')
  })

  it('routes every storage mount through HOST_STORAGE_PATH', () => {
    const mounts = code.match(/^\s*- \S+:\/app\/storage$/gm) ?? []
    // Two: one per color. The migrator needs no storage.
    expect(mounts).toHaveLength(2)
    for (const m of mounts) expect(m).toContain('${HOST_STORAGE_PATH:-./data/storage}')
  })

  it('declares the shared network external, so neither project can remove it', () => {
    expect(code).toMatch(/shared:\s*\n\s*external: true\s*\n\s*name: \$\{SHARED_DB_NETWORK/)
  })
})

describe('stage requires the keys whose absence would be silent', () => {
  // HOST_STORAGE_PATH is the one that matters. Its compose default is stage's
  // OWN empty directory, so a stage server missing the key comes up, passes its
  // healthcheck, and serves production's rides with every stored file missing —
  // which reads as data loss rather than as a missing variable. DB_HOST fails
  // loudly on its own (nothing resolves, /healthz 503s) and is required anyway
  // so the two cannot drift apart.
  it('adds the three shared-database keys to REMOTE_ENV_KEYS on stage only', () => {
    const block = /if \[ "\$DEPLOY_ENV" = "stage" \]; then\n\s*REMOTE_ENV_KEYS="\$\{REMOTE_ENV_KEYS\}([^"]*)"/.exec(
      deploySh,
    )
    expect(block).toBeTruthy()
    for (const key of ['DB_HOST', 'HOST_STORAGE_PATH', 'SHARED_DB_NETWORK']) {
      expect(block?.[1]).toContain(key)
    }
  })

  // Prod must NOT require them: its compose defaults are already the right
  // answers, and requiring them would fail the very deploy that introduces
  // them — the documented push-env ordering trap, from the expensive end.
  it('leaves the base list free of them, so prod does not fail on their absence', () => {
    const base = /^REMOTE_ENV_KEYS="([\s\S]*?)"/m.exec(deploySh)?.[1] ?? ''
    expect(base).toContain('DB_VOLUME_NAME')
    expect(base).not.toContain('HOST_STORAGE_PATH')
  })
})

describe('only the environment that owns the database migrates it', () => {
  it('gates converge, readiness and migrate behind RUNS_DATABASE', () => {
    expect(deploySh).toMatch(/if \[ -n "\$\{RUNS_DATABASE:-\}" \]; then/)
    expect(deployConfig).toMatch(/^PROD_RUNS_DATABASE="yes"$/m)
    expect(deployConfig).toMatch(/^STAGE_RUNS_DATABASE=""$/m)
  })

  it('points stage at prod’s database container and prod at its own service name', () => {
    expect(deployConfig).toMatch(/^PROD_DB_HOST="db"$/m)
    expect(deployConfig).toMatch(/^STAGE_DB_HOST="\$PROD_DB_CONTAINER_NAME"$/m)
  })

  it('shares one storage directory, prod’s, in both environments', () => {
    expect(deployConfig).toMatch(/^HOST_STORAGE_PATH="\$\{NAS_DEPLOY_BASE\}\/\$\{PROD_DOMAIN\}\/data\/storage"$/m)
  })
})

describe('the staging banner does not promise the opposite of the truth', () => {
  const layout = read('src/views/layout.tsx')
  const banner = /function stageBanner\(\)[\s\S]*?\n}/.exec(layout)?.[0] ?? ''

  it('renders a banner at all', () => {
    expect(banner).toContain('tb-banner is-stage')
  })

  // The old copy read "Rides planned here are wiped whenever this environment is
  // refreshed from production." It was true until stage lost its own database
  // and is now exactly backwards — and it is the sentence that would talk
  // somebody into deleting a real rider's ride to see what the button did.
  it('never tells a rider their work here is disposable', () => {
    expect(banner).not.toMatch(/wiped|refreshed from production|disposable|throwaway/i)
  })

  it('says the data is real and that deleting is permanent', () => {
    expect(banner).toMatch(/real rider data/i)
    expect(banner).toMatch(/deleted for/i)
  })
})
