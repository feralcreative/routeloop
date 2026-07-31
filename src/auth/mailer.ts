// Outbound mail for magic links.
//
// This credential is deliberately unrelated to the sign-in OAuth client. Mail
// goes out from the app's own address, never as the signed-in user, which is
// what keeps a Gmail scope off the consent screen and the project out of
// Google's restricted-scope verification. See docs/google-cloud-setup.md.
import nodemailer from 'nodemailer'
import { MAGIC_LINK_ENABLED, MAIL_FROM, SMTP_HOST, SMTP_PASS, SMTP_PORT, SMTP_USER } from '../config'

let transport: nodemailer.Transporter | null = null

function getTransport(): nodemailer.Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465, // 587 negotiates STARTTLS instead
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  }
  return transport
}

export class MailError extends Error {}

export async function sendMail(to: string, subject: string, text: string, html: string): Promise<void> {
  if (!MAGIC_LINK_ENABLED) throw new MailError('mail is not configured')
  try {
    await getTransport().sendMail({ from: MAIL_FROM, to, subject, text, html })
  } catch (err) {
    // Gmail caps sending at roughly 2,000 recipients a day on Workspace and 500
    // on a consumer account. Hitting that wall looks like a generic SMTP failure,
    // so log the real reason rather than swallowing it — the route above returns
    // the same opaque response to the user either way.
    console.error('[mail] send failed:', err instanceof Error ? err.message : err)
    throw new MailError('could not send mail')
  }
}
