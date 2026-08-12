// Guards around the connection string.
//
// redactDatabaseUrl exists because two scripts refuse to run against a non-local
// database and print which one they refused. Printing it is the point — it is
// how you diagnose a misconfigured .env — so this has to hide the credential
// without hiding the host.
import { describe, expect, it } from 'vitest'
import { isLocalDatabaseUrl, redactDatabaseUrl } from '../src/config'

describe('isLocalDatabaseUrl', () => {
  it('accepts the three hosts a dev database actually uses', () => {
    for (const h of ['127.0.0.1', 'localhost', 'host.docker.internal']) {
      expect(isLocalDatabaseUrl(`postgres://u:p@${h}:5432/routeloop`)).toBe(true)
    }
  })

  it('rejects anything else, which is what stops a seeder truncating production', () => {
    expect(isLocalDatabaseUrl('postgres://u:p@nas.feralcreative.co:5432/routeloop')).toBe(false)
    expect(isLocalDatabaseUrl('')).toBe(false)
  })

  it('is not fooled by a local-looking name in the path or query', () => {
    expect(isLocalDatabaseUrl('postgres://u:p@prod.example.com/localhost')).toBe(false)
    expect(isLocalDatabaseUrl('postgres://u:p@prod.example.com/db?h=127.0.0.1')).toBe(false)
  })
})

describe('redactDatabaseUrl', () => {
  it('hides the password in the userinfo', () => {
    expect(redactDatabaseUrl('postgres://routeloop:s3cr3t@127.0.0.1:5432/routeloop')).toBe(
      'postgres://***@127.0.0.1:5432/routeloop',
    )
  })

  it('hides a password passed as a query parameter', () => {
    // The leak the old one-line regex had: libpq accepts this form and some
    // hosted providers hand out URLs shaped exactly like it.
    expect(redactDatabaseUrl('postgres://routeloop@host/db?password=hunter2')).toBe(
      'postgres://***@host/db?password=***',
    )
    expect(redactDatabaseUrl('postgres://host/db?sslmode=require&password=hunter2')).toBe(
      'postgres://host/db?sslmode=require&password=***',
    )
  })

  it('keeps the host visible, which is the entire reason it is printed', () => {
    // The old regex used [^@]* and so ran past the path: an @ anywhere later in
    // the URL swallowed the host and produced 'postgres://***@b'.
    expect(redactDatabaseUrl('postgres://host/db?opt=a@b')).toContain('host')
    expect(redactDatabaseUrl('postgres://u:p@nas.feralcreative.co/routeloop')).toContain('nas.feralcreative.co')
  })

  it('never leaves the secret in the output', () => {
    for (const u of [
      'postgres://routeloop:s3cr3t@127.0.0.1:5432/routeloop',
      'postgres://routeloop@host/db?password=s3cr3t',
      'postgres://routeloop:s3cr3t@host/db?password=s3cr3t',
    ]) {
      expect(redactDatabaseUrl(u)).not.toContain('s3cr3t')
    }
  })

  it('leaves a URL with nothing to hide alone', () => {
    expect(redactDatabaseUrl('postgres://127.0.0.1:5432/routeloop')).toBe('postgres://127.0.0.1:5432/routeloop')
    expect(redactDatabaseUrl('')).toBe('')
  })
})
