// Usage analytics: the rule that decides what a page emits, the shape checks
// that make the two ids safe to interpolate, and the text pins that hold the
// deploy wiring in step. See src/views/analytics.ts for the design.
//
// The rule is pure and pinned as behavior. The wiring — a middleware in
// index.tsx, two keys in a shell script and a compose file, one opt-out on the
// invite page — is pinned as TEXT, for the reason test/stage-shares-prod-db
// gives: CI runs no Docker and no server, so the source is the only place a
// deploy script can be checked for free, and a key missing from one of the two
// lists fails silently with the container passing its healthcheck.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONSENT_COUNTRIES,
  analyticsPlan,
  cfBeaconSnippet,
  consentBarHtml,
  gaBootstrap,
  isConsentCountry,
} from '../src/views/analytics'
import { isCfBeaconToken, isGaMeasurementId } from '../src/config'

const GA = 'G-ABCD1234'
const CF = '0123456789abcdef0123456789abcdef'

const EU27 = 'AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' ')

// Strings that would close a tag or an attribute if they ever reached markup.
// Every builder has to answer '' for all of them, because nothing downstream
// escapes: validation is the escaping.
const HOSTILE = [
  '</script>',
  '"><img src=x onerror=alert(1)>',
  "' onerror='",
  'G-ABCD\u2028',
  'G-ABCD1234 ',
  ' G-ABCD1234',
]

describe('isConsentCountry', () => {
  it('is the EU27, the EEA three, the UK, Switzerland and Tor — 33 codes', () => {
    expect(CONSENT_COUNTRIES.size).toBe(33)
    for (const c of EU27) expect(isConsentCountry(c)).toBe(true)
    for (const c of ['IS', 'LI', 'NO', 'GB', 'CH', 'T1']) expect(isConsentCountry(c)).toBe(true)
  })

  it('is nobody else, including the two ways Cloudflare says "unknown"', () => {
    for (const c of ['US', 'CA', 'MX', 'AU', 'JP', 'BR', '', 'XX']) expect(isConsentCountry(c)).toBe(false)
  })

  it('normalizes case and whitespace, since a header is not trusted to be tidy', () => {
    expect(isConsentCountry('de')).toBe(true)
    expect(isConsentCountry(' DE ')).toBe(true)
    expect(isConsentCountry(' us ')).toBe(false)
  })
})

describe('analyticsPlan', () => {
  const on = { prod: true, gaId: GA, cfToken: CF }

  it('emits both directly for a visitor nobody asks', () => {
    expect(analyticsPlan({ ...on, country: 'US' })).toEqual({ ga: 'direct', cf: true })
  })

  it('asks in a consent country and over Tor', () => {
    expect(analyticsPlan({ ...on, country: 'DE' })).toEqual({ ga: 'consent', cf: true })
    expect(analyticsPlan({ ...on, country: 'GB' })).toEqual({ ga: 'consent', cf: true })
    expect(analyticsPlan({ ...on, country: 'T1' })).toEqual({ ga: 'consent', cf: true })
  })

  // Prod only ever answers from behind Cloudflare, so a missing header there is
  // a proxy fault and not a visitor; treating it as "ask" would put the bar in
  // front of every rider the moment a header went missing.
  it('reads a missing or unknown country as "do not ask"', () => {
    expect(analyticsPlan({ ...on, country: '' }).ga).toBe('direct')
    expect(analyticsPlan({ ...on, country: 'XX' }).ga).toBe('direct')
  })

  it('emits nothing outside production, whatever else is set', () => {
    expect(analyticsPlan({ ...on, prod: false, country: 'US' })).toEqual({ ga: 'off', cf: false })
    expect(analyticsPlan({ ...on, prod: false, country: 'DE' })).toEqual({ ga: 'off', cf: false })
  })

  it('treats each key independently', () => {
    expect(analyticsPlan({ ...on, gaId: '', country: 'US' })).toEqual({ ga: 'off', cf: true })
    expect(analyticsPlan({ ...on, cfToken: '', country: 'US' })).toEqual({ ga: 'direct', cf: false })
    expect(analyticsPlan({ ...on, gaId: '', cfToken: '', country: 'DE' })).toEqual({ ga: 'off', cf: false })
  })

  it('turns a malformed id off rather than emitting it', () => {
    for (const bad of ['G-abc', 'UA-1234-1', 'G-12<script>', 'G-ABC', ...HOSTILE]) {
      expect(analyticsPlan({ ...on, gaId: bad, country: 'US' }).ga).toBe('off')
    }
  })
})

describe('the shape checks that stand in for escaping', () => {
  it('accept exactly a GA4 measurement id', () => {
    expect(isGaMeasurementId('G-ABCD1234')).toBe(true)
    expect(isGaMeasurementId('G-1234567890')).toBe(true)
    for (const bad of ['g-abcd1234', 'G-ABC', 'G-ABCD 1234', 'G-ABCD"1234', 'UA-1234-1', '', ...HOSTILE]) {
      expect(isGaMeasurementId(bad)).toBe(false)
    }
  })

  it('accept exactly a 32-hex Cloudflare token', () => {
    expect(isCfBeaconToken(CF)).toBe(true)
    expect(isCfBeaconToken(CF.slice(0, 31))).toBe(false)
    expect(isCfBeaconToken(CF.toUpperCase())).toBe(false)
    expect(isCfBeaconToken(CF + '0')).toBe(false)
    for (const bad of ['', '</script>', CF.slice(0, 24) + '</script'.padEnd(8, 'a')]) {
      expect(isCfBeaconToken(bad)).toBe(false)
    }
  })
})

describe('the builders', () => {
  it('answer empty for anything that fails the shape check', () => {
    for (const bad of HOSTILE) {
      expect(gaBootstrap(bad, false)).toBe('')
      expect(gaBootstrap(bad, true)).toBe('')
      expect(cfBeaconSnippet(bad)).toBe('')
    }
  })

  it('hand consent.js the id and whether to ask, and load nothing from Google themselves', () => {
    const direct = gaBootstrap(GA, false)
    expect(direct).toContain('window.TBConsent = {"gaId":"G-ABCD1234","ask":false}')
    expect(direct).toContain('/js/consent.js')
    expect(direct).not.toContain('googletagmanager')
    expect(gaBootstrap(GA, true)).toContain('"ask":true')
  })

  it('emit the Cloudflare beacon with the token as its JSON attribute', () => {
    const cf = cfBeaconSnippet(CF)
    expect(cf).toContain('src="https://static.cloudflareinsights.com/beacon.min.js"')
    expect(cf).toContain(`data-cf-beacon='{"token":"${CF}"}'`)
    expect(cf).toContain(' defer')
  })
})

describe('the consent bar', () => {
  const bar = consentBarHtml()

  it('ships hidden, in the banner construction, with the two answers and the link', () => {
    expect(bar).toContain('class="tb-banner is-consent"')
    expect(bar).toContain(' hidden>')
    expect(bar).toContain('href="/privacy"')
    expect(bar).toContain('data-consent="granted"')
    expect(bar).toContain('data-consent="denied"')
  })

  it('names the two answers as a guide sign and a quiet button', () => {
    expect(bar).toMatch(/class="btn" data-consent="granted">Fine by me</)
    expect(bar).toMatch(/class="btn btn-quiet" data-consent="denied">No thanks</)
  })

  // The sweep in test/smart-quotes.test.ts walks git ls-files for .ts, so this
  // is covered there too; pinned here because the text is assembled in a
  // template literal, where a straight quote is the easy mistake.
  it('uses no straight quote in its copy', () => {
    const text = bar.replace(/<[^>]+>/g, '')
    expect(text).not.toMatch(/['"]/)
  })
})

// --- The wiring, as text -----------------------------------------------------

const root = join(__dirname, '..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const code = (s: string) =>
  s
    .split('\n')
    .filter((l) => !/^\s*(#|\/\/)/.test(l))
    .join('\n')

describe('the wiring', () => {
  it('registers contextStorage() below /healthz and above every other middleware', () => {
    const src = code(read('src/index.tsx'))
    const healthz = src.indexOf("app.get('/healthz'")
    const storage = src.indexOf("app.use('*', contextStorage())")
    const legacy = src.indexOf('const canonical = LEGACY_HOSTS[host]')
    expect(healthz).toBeGreaterThan(-1)
    expect(storage).toBeGreaterThan(healthz)
    expect(legacy).toBeGreaterThan(storage)
  })

  it('has exactly one reader of the request context in the view layer', () => {
    const analytics = read('src/views/analytics.ts')
    expect(analytics).toContain('tryGetContext()')
    const layout = read('src/views/layout.tsx')
    expect(layout).not.toContain('getContext')
  })

  it('sends both keys, optional, and requires neither', () => {
    const sh = code(read('utils/deploy/deploy.sh'))
    expect(sh).toContain('"GA_MEASUREMENT_ID=${GA_MEASUREMENT_ID:-}"')
    expect(sh).toContain('"CF_BEACON_TOKEN=${CF_BEACON_TOKEN:-}"')
    const required = /REMOTE_ENV_KEYS="([\s\S]*?)"/.exec(sh)?.[1] ?? ''
    expect(required).not.toContain('GA_MEASUREMENT_ID')
    expect(required).not.toContain('CF_BEACON_TOKEN')
  })

  it('refuses to ship the dev knob', () => {
    const sh = code(read('utils/deploy/deploy.sh'))
    expect(sh).toMatch(/for FORBIDDEN in [^\n]*ANALYTICS_DEV_COUNTRY/)
  })

  it('reaches both colors through compose, with a default so an older .env does not warn', () => {
    const compose = code(read('docker-compose.prod.yml'))
    expect(compose.match(/^\s+GA_MEASUREMENT_ID: \$\{GA_MEASUREMENT_ID:-\}$/gm)).toHaveLength(2)
    expect(compose.match(/^\s+CF_BEACON_TOKEN: \$\{CF_BEACON_TOKEN:-\}$/gm)).toHaveLength(2)
  })

  it('keeps the invite page out, because its path is the token', () => {
    const invites = code(read('src/routes/invites.tsx'))
    expect(invites).toContain('analytics: false')
  })

  it('documents both keys in .env.example', () => {
    const example = read('.env.example')
    expect(example).toContain('# GA_MEASUREMENT_ID=')
    expect(example).toContain('# CF_BEACON_TOKEN=')
    expect(example).toContain('# ANALYTICS_DEV_COUNTRY=')
  })
})
