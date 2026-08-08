// Send every template in the registry to a real inbox.
//
// The suite renders these same templates and asserts on the output, but nothing
// in it can tell you that Outlook dropped the padding or that Gmail's dark mode
// inverted a cell into mud. That check needs a client, which needs a delivery.
//
// Subjects are left exactly as the template produces them. Prefixing them with
// [preview] would alter the one line you are most likely evaluating.
//
//   npx tsx utils/email-preview.mts [recipient]
//
// Requires the mail block in .env to be configured; it sends through whatever
// provider is set there, so a real send costs a real message against the quota.
//
// The wordmark is an <img> pointing at APP_ORIGIN, which is http://127.0.0.1:6686
// in development — an address no inbox can reach. Left alone, every preview
// arrives with a broken header, which is the one part of the message you are
// most likely previewing. EMAIL_ASSET_ORIGIN rewrites just those URLs on the way
// out:
//
//   EMAIL_ASSET_ORIGIN=https://tankbag.app npx tsx utils/email-preview.mts
//
// It is read here and nowhere else on purpose. The app has no business knowing
// that a developer's laptop is unreachable, so this stays a property of the
// preview rather than a third origin in src/config.ts.
import 'dotenv/config'
import nodemailer from 'nodemailer'
import { APP_ORIGIN } from '../src/config'
import { ALL_EMAILS } from '../src/emails/index'
import { renderEmail } from '../src/emails/shell'

const TO = process.argv[2] ?? process.env.OWNER_EMAIL ?? 'ziad@feralcreative.co'

const host = process.env.SMTP_HOST ?? ''
const port = Number(process.env.SMTP_PORT ?? 587)
const from = process.env.MAIL_FROM ?? ''

if (!host || !from || !process.env.SMTP_PASS) {
  throw new Error('mail is not configured in .env -- see docs/email.md')
}

const transport = nodemailer.createTransport({
  host,
  port,
  // 465 is implicit TLS, everything else is STARTTLS. Same switch mailer.ts makes.
  secure: port === 465,
  auth: { user: process.env.SMTP_USER ?? '', pass: process.env.SMTP_PASS ?? '' },
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Only the /img/ prefix, never the whole origin: the links in the body are what
// you are checking too, and silently pointing them at production would make a
// preview of the magic-link email actively misleading.
const ASSET_ORIGIN = (process.env.EMAIL_ASSET_ORIGIN ?? '').replace(/\/+$/, '')
const withAssets = (html: string) =>
  ASSET_ORIGIN ? html.replaceAll(`src="${APP_ORIGIN}/img/`, `src="${ASSET_ORIGIN}/img/`) : html

if (!ASSET_ORIGIN && !APP_ORIGIN.startsWith('https://')) {
  console.warn(
    `warning: images point at ${APP_ORIGIN}, which an inbox cannot reach — the wordmark will be broken.\n` +
      '         set EMAIL_ASSET_ORIGIN=https://tankbag.app to preview it.\n',
  )
}

for (const tpl of ALL_EMAILS) {
  const out = renderEmail(tpl, tpl.sample)
  await transport.sendMail({
    from: `Tankbag <${from}>`,
    to: TO,
    subject: out.subject,
    text: out.text,
    html: withAssets(out.html),
  })
  console.log(`sent ${tpl.key.padEnd(14)} ${out.subject}`)
  await sleep(700)
}

console.log(`all ${ALL_EMAILS.length} templates sent to ${TO}`)
