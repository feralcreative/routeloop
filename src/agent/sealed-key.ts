// Seals a rider's own Anthropic or OpenAI key at rest. PURE apart from node:crypto.
//
// AES-256-GCM under AI_KEY_ENCRYPTION_KEY: GCM rather than CBC because it is
// authenticated, so a row edited in the database fails to open instead of opening
// to garbage that is then sent to a provider as somebody's key. A fresh 12-byte IV
// per seal, never reused under one master key.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export type Sealed = { ciphertext: string; iv: string; tag: string; last4: string }

export function masterKey(b64: string): Buffer | null {
  if (!b64) return null
  const key = Buffer.from(b64, 'base64')
  return key.length === 32 ? key : null
}

export function seal(plain: string, master: Buffer): Sealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', master, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    last4: plain.slice(-4),
  }
}

/** Null on any failure — a tampered row, a rotated master key — and never throws,
 *  because the caller's answer to all of them is the same: ask for the key again. */
export function open(s: Pick<Sealed, 'ciphertext' | 'iv' | 'tag'>, master: Buffer): string | null {
  try {
    const decipher = createDecipheriv('aes-256-gcm', master, Buffer.from(s.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(s.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(s.ciphertext, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/** The shape of an Anthropic API key, checked before anything is spent on it. */
export const looksLikeAnthropicKey = (v: string) => /^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(v)

/** The shape of an OpenAI API key (`sk-proj-…`, `sk-svcacct-…`, or a legacy
 *  `sk-…`), and never an Anthropic one pasted into the wrong box. */
export const looksLikeOpenAIKey = (v: string) => /^sk-[A-Za-z0-9_-]{20,300}$/.test(v) && !v.startsWith('sk-ant-')

/** Each provider's key shape, by provider, for the store and the open. */
export const LOOKS_LIKE: Record<'anthropic' | 'openai', (v: string) => boolean> = {
  anthropic: looksLikeAnthropicKey,
  openai: looksLikeOpenAIKey,
}
