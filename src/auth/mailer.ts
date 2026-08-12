// Outbound mail.
//
// This credential is deliberately unrelated to the sign-in OAuth client. Mail
// goes out from the app's own address, never as the signed-in user, which is
// what keeps a Gmail scope off the consent screen and the project out of
// Google's restricted-scope verification. See docs/email.md.
//
// The transport is plain SMTP on purpose. Every transactional provider speaks
// it, so changing provider is a change to .env and nothing else — the app moved
// from a personal Gmail account to Resend without a line of this file changing
// shape. An HTTP API would have bought a little and cost that.
import nodemailer from 'nodemailer'
import { MAIL_ENABLED, MAIL_FROM, SMTP_HOST, SMTP_PASS, SMTP_PORT, SMTP_USER } from '../config'
import { allow } from './ratelimit'
import { renderEmail } from '../emails/shell'
import type { EmailTemplate } from '../emails/types'

let transport: nodemailer.Transporter | null = null

function getTransport(): nodemailer.Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465, // 587 negotiates STARTTLS instead
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      // Without these a hung SMTP session pins a socket for minutes after the
      // HTTP response that triggered it has already gone out. Notifications are
      // sent detached, so nobody is waiting on them and nothing else would
      // notice the leak.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    })
  }
  return transport
}

export class MailError extends Error {}

export type SendOpts = {
  to: string
  subject: string
  text: string
  html: string
  replyTo?: string
}

export async function sendMail(o: SendOpts): Promise<void> {
  if (!MAIL_ENABLED) throw new MailError('mail is not configured')
  try {
    await getTransport().sendMail({
      // MAIL_FROM is a bare address; the display name is composed here. Keeping
      // the `Name <addr>` form out of the environment sidesteps a real quoting
      // problem — deploy.sh writes the value into a compose .env through printf,
      // where quoting rules differ from a shell's and a stray character would
      // reach the SMTP envelope.
      from: `RouteLoop <${MAIL_FROM}>`,
      to: o.to,
      subject: o.subject,
      text: o.text,
      html: o.html,
      replyTo: o.replyTo,
    })
  } catch (err) {
    // Providers rate-limit and reject for reasons the caller cannot see, and the
    // route above returns the same opaque response either way, so the real
    // reason has to reach the log or it is lost. Resend's free tier is 3,000 a
    // month; hitting a cap presents as a generic SMTP failure.
    console.error('[mail] send failed:', err instanceof Error ? err.message : err)
    throw new MailError('could not send mail')
  }
}

/** Renders a template and sends it. Throws MailError, like sendMail. */
export async function sendTemplate<P>(
  to: string,
  t: EmailTemplate<P>,
  props: P,
  o?: { replyTo?: string },
): Promise<void> {
  const { subject, text, html } = renderEmail(t, props)
  await sendMail({ to, subject, text, html, replyTo: o?.replyTo })
}

/**
 * Sends without blocking or failing the caller.
 *
 * Notifications must never fail the request that triggered them: an approval
 * email that throws would roll back nothing but would 500 the admin's POST after
 * the status change had already committed, which is a worse outcome than a
 * missing email. So this returns void, not a promise, and swallows everything
 * into the log.
 *
 * The `.catch()` is attached HERE, synchronously, and that is the most important
 * line in the file. Node's default is `--unhandled-rejections=throw`, so a
 * rejected promise with no handler terminates the process — `void sendTemplate()`
 * at a call site would not be a lost email, it would be a crashed server. Living
 * in here means no call site can forget it.
 *
 * There is no retry and no queue. This app has no scheduler at all — note that
 * deleteExpiredLoginTokens and deleteExpiredSessions are both uncalled — and
 * introducing the first one for the lowest-stakes feature in it would invert a
 * decision already made. A lost approval is visible in /admin and can be re-sent
 * by hand; once the provider accepts a message it does its own retrying.
 */
export function sendTemplateDetached<P>(
  to: string | null | undefined,
  t: EmailTemplate<P>,
  props: P,
  o?: { replyTo?: string; limitKey?: string },
): void {
  // Distinct from a failure, and logged differently on purpose: "not configured"
  // is expected forever on a Google-only deployment and is not actionable, while
  // a send failure is. An error-level line for the former trains people to
  // ignore the latter.
  if (!MAIL_ENABLED) {
    console.info(`[mail] ${t.key} skipped: mail is not configured`)
    return
  }
  // users.email is nullable.
  if (!to) {
    console.warn(`[mail] ${t.key} skipped: no recipient`)
    return
  }
  // A spam brake, not a security control — in-memory and per-process, which is
  // honest for one container. The magic link deliberately does NOT come through
  // here: magic.ts has a database-backed per-address limit that survives a
  // restart, and a second in-memory one would only mask it.
  //
  // limitKey exists because the owner alert always goes to the same address, so
  // keying on the recipient would drop legitimate alerts during a signup burst.
  // That caller passes the new rider's id instead.
  if (!allow(`mail:${t.key}`, o?.limitKey ?? to, { max: 5, windowMs: 60 * 60 * 1000 })) {
    console.warn(`[mail] ${t.key} rate limited for ${to}`)
    return
  }

  void sendTemplate(to, t, props, o).catch((err) => {
    console.error(`[mail] ${t.key} -> ${to} FAILED:`, err instanceof Error ? err.message : err)
  })
}
