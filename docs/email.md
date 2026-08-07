# Email

**Updated:** 2026-08-07

How Tankbag sends mail, what it sends, and what to do when it stops working. Architecture is in [\_AI_AGENT_PRIMER.md](../_AI_AGENT_PRIMER.md); this covers the mail subsystem alone.

## The shape of it

**Sending is Resend over plain SMTP.** Not Resend's HTTP API, and the distinction is the whole design: because every transactional provider speaks SMTP, changing provider is a change to five values in `.env` and nothing else. The app moved off a personal Gmail account without `src/auth/mailer.ts` changing shape.

**Receiving is Cloudflare Email Routing**, which forwards `@tankbag.app` to an existing inbox. Free and unlimited on the plan the domain is already on. There is no mailbox to pay for and no mail server anywhere—a mail server on the NAS was considered and rejected: residential IPs sit on blocklists, outbound port 25 is usually blocked by the ISP, and the PTR record you would need is not yours to set.

**Cloudflare Email Sending was rejected** for the outbound half. It is still in beta, requires the Workers Paid plan, and is REST-only, so `mailer.ts` would have been rewritten around `fetch()` to get something SMTP already does. Worth revisiting once it is GA.

| | Value |
| --- | --- |
| `SMTP_HOST` | `smtp.resend.com` |
| `SMTP_PORT` | `587` (STARTTLS; 465 would be implicit TLS and `mailer.ts` switches on it) |
| `SMTP_USER` | the literal string `resend`—**not** an address |
| `SMTP_PASS` | the Resend API key |
| `MAIL_FROM` | a **bare** address, e.g. `hello@tankbag.app` |

Free tier is 3,000 messages a month, which is far beyond what a hand-approved beta uses.

## Two traps that have real symptoms

**`SMTP_USER` is `resend`, so `MAIL_FROM` must be set explicitly.** `MAIL_FROM` used to default to `SMTP_USER`, which was right under Gmail where the SMTP user *is* the address. Under Resend that default would make `MAIL_FROM` the string `resend`—truthy, so `MAIL_ENABLED` goes true, the sign-in form renders, and every send fails at the server with a 550 that nothing local would have caught. The default is now `''` (`src/config.ts`).

**`MAIL_FROM` must be a bare address, never `Tankbag <hello@tankbag.app>`.** The display name is composed in `mailer.ts`. The bracketed form has to survive `printf` into a compose `.env`, where quoting rules differ from a shell's and a `#` starts a comment. `deploy.sh` rejects it rather than shipping a malformed envelope that only shows up in a recipient's headers.

**Do not set `OWNER_EMAIL` to the same address as `MAIL_FROM`.** With Routing forwarding `@tankbag.app` back to Gmail, the owner alert would go Resend → Cloudflare → Gmail from and to the same domain, which reads as a loop to filters and lands in spam.

## What it sends

Four templates, all in `src/emails/`. Every one produces a subject, a plain-text body and an HTML body from a single definition.

| Template | Trigger | To | Sent again? |
| --- | --- | --- | --- |
| `magic-link` | the email form on `/login` | the requester | every request, rate-limited per address in `auth/magic.ts` |
| `waitlist` | a sign-in that **creates** a non-active account | the new rider | never—`created` is true only for the row the INSERT produced |
| `approved` | `/admin` moving an account into `active` | the rider | never, unless `approved_email_at` is cleared |
| `owner-signup` | same trigger as `waitlist` | `OWNER_EMAIL` | never |

**The approval email is the one with real machinery behind it**, because `/admin` can toggle `active → blocked → active` freely and every one of those is a genuine status change. Two layers:

- `users.approved_email_at`—nullable, no default. Makes the message exactly-once for the life of an account and survives a `pending → blocked → active` path that a status check alone would re-send on.
- A conditional `UPDATE ... WHERE id = ? AND status <> ? RETURNING` in `src/routes/admin.tsx`. The **database** decides which request made the change, so two managers clicking Approve at the same instant cannot both come back with a row.

The policy half is `shouldSendApproval` / `shouldSendWaitlist` in `src/emails/rules.ts`, kept pure so it is a table test rather than a condition buried in a side effect. The SQL is the race guard; the functions are the rule. Neither substitutes for the other.

**To re-send an approval deliberately:**

```sql
UPDATE users SET approved_email_at = NULL WHERE email = 'rider@example.com';
```

Then block and re-approve them in `/admin`.

## Failure is isolated, on purpose

Notifications go through `sendTemplateDetached()`, which returns `void`, never throws, and logs. An approval email that fails must not 500 the admin's POST after the status change has already committed.

**The `.catch()` lives inside that helper, and that is the most important line in `mailer.ts`.** Node's default is `--unhandled-rejections=throw`, so `void sendTemplate(...)` at a call site would not be a lost email—it would be a crashed server. Keeping it in the helper means no call site can forget it.

**There is no retry and no queue.** This app has no scheduler at all (note that `deleteExpiredLoginTokens` and `deleteExpiredSessions` are both uncalled), and introducing the first one for the lowest-stakes feature would invert a decision already made. A lost approval is visible in `/admin` and can be re-sent by hand; once Resend accepts a message it does its own retrying.

## When mail is not configured

`MAIL_ENABLED` is `SMTP_USER && SMTP_PASS && MAIL_FROM`. With any of them unset:

- `sendMail` throws, so the magic-link path fails loudly (its form is hidden anyway).
- `sendTemplateDetached` **short-circuits before rendering** and logs `info … not configured`. That is deliberately not an error: on a Google-only deployment it is expected forever and is not actionable, and an error-level line for it trains people to ignore the real ones.
- The app runs normally on Google sign-in. Nobody is notified of anything.

`MAGIC_LINK_ENABLED` is a separate name for the same expression on purpose. `MAIL_ENABLED` is a capability—can this deployment reach an inbox? `MAGIC_LINK_ENABLED` is a product decision—is emailed sign-in *offered*? A deployment that wants Google-only sign-in while still mailing approvals turns off the second, not the first.

## Writing a template

Templates are Hono JSX under `src/emails/`, **not** `src/content/*.html`. The content loader substitutes tokens with a bare `String()` and no escaping at all—fine for a date on a legal page, wrong for a rider-supplied display name in an outbound message—and its own docblock says it will not grow conditionals. JSX escapes by default.

Every template is a `defineEmail({ key, subject, preheader, text, html, sample })`. `text` is authored by hand rather than derived from the HTML: deriving needs a dependency, produces text nobody would have written, and hides the one place the message must work with no markup. The type makes it required, which is the enforcement.

`sample` is what makes the whole set testable—`test/emails.test.ts` renders every template through it without knowing any template's prop shape, so a new email is covered the moment it joins `ALL_EMAILS`.

**Add a template to `src/emails/index.ts` or it is not tested.** Nothing else enforces that.

### The email HTML rules

Not stylistic. Outlook on Windows renders with Word's engine, Gmail clips a long `<style>` block, and several mobile clients force-invert colors regardless of what you asked for.

- Layout is tables. Padding goes on a `<td>`—Word drops it on a `<div>`.
- Every style that **matters** is an inline `style=`. The `<style>` block may only improve a message that is already correct without it.
- Build light. A white card with dark text inverts cleanly; an already-dark design inverts to grey mud.
- Never set `color` without `background-color` on the same element. A lone `color` is what produces dark-on-dark text under forced inversion.
- **No quote characters in any CSS value.** Hono escapes `'` to `&#39;` inside an attribute; a browser decodes that before the CSS parser sees it and Word is not reliably a browser. `src/emails/theme.ts` keeps the font stack unquoted for this reason—CSS permits a family name to be a sequence of identifiers.
- Colors come from `theme.ts` and nowhere else. `test/email-theme.test.ts` pins those values against `style/_tokens.scss` and fails if a template invents a hex.

### The logo is text, not an image

The header wordmark is styled text. A remote image is blocked by default in a large share of clients, so a logo is the one element guaranteed not to render on first open, and a transparent-background PNG additionally vanishes where the client inverts the cell behind it. Text always renders.

If it becomes an image it needs a **new** asset: roughly 360×104, opaque background, PNG—no client renders SVG in email. The existing `public/img/logo-tankbag-horiz-light@2x.png` is 2911×852 and 84 KB, which is an absurd payload for every inbox. Whatever replaces it must still read correctly with images disabled, which means alt text carrying the wordmark and no information living only in the picture.

## Setting it up from scratch

Outside the repo, in this order:

1. **Resend**—add `tankbag.app`, put the SPF and DKIM records it gives you into Cloudflare DNS, wait for verification, create an API key.
2. **DMARC**—add a TXT record at `_dmarc.tankbag.app`: `v=DMARC1; p=quarantine; rua=mailto:dmarc@tankbag.app`.
3. **Cloudflare Email Routing**—enable on `tankbag.app`, verify the destination inbox, route `hello@` and `no-reply@` to it. Do this even if only sending: replies to an address that hard-bounces hurt sender reputation.

Then set the five SMTP values in `.env`. They are already on the deploy allow-list in `utils/deploy/deploy.sh` and already forwarded in `docker-compose.prod.yml`, so no plumbing changes.

## Checking it works

```bash
npm run typecheck && npm test
```

Then, against a real inbox—none of the below is covered by the suite, which is pure-logic only:

1. Request a magic link and confirm the delivered body matches the copy of record.
2. Sign in with a fresh address by both methods. Two emails per signup; a second sign-in with the same address sends neither.
3. Approve the rider in `/admin`, then toggle `active → blocked → active` and confirm **no** second email.
4. Unset `SMTP_PASS`, restart, approve someone: the POST must succeed and the log must say `info … not configured`.
5. Read every template with **images disabled**, then in Outlook, Gmail dark mode on Android, and Apple Mail.
6. In Gmail, "Show original" and confirm `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`.
7. Point `SMTP_HOST` at an unroutable address and approve someone. The process must log and stay up.
