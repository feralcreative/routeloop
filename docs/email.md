# Email

**Updated:** 2026-08-08

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
- Build light. A white card with dark text inverts cleanly; an already-dark design inverts to grey mud. Dark mode sits on top of this rather than replacing it—see below.
- Never set `color` without `background-color` on the same element. A lone `color` is what produces dark-on-dark text under forced inversion.
- **No quote characters in any CSS value.** Hono escapes `'` to `&#39;` inside an attribute; a browser decodes that before the CSS parser sees it and Word is not reliably a browser. `src/emails/theme.ts` keeps the font stack unquoted for this reason—CSS permits a family name to be a sequence of identifiers.
- Colors come from `theme.ts` and nowhere else. `test/email-theme.test.ts` pins those values against `style/_tokens.scss` and fails if a template invents a hex.

### The logo, and why there are two of them

The header wordmark is a PNG, one per color scheme, swapped by the dark-mode block described below. It used to be styled text, on the grounds that a remote image is blocked by default in a large share of clients and so is the one element guaranteed not to render on first open. That is still true, which is why both copies carry `alt="tankbag."` and every style that governs **alt text**—font, size, weight, color—sits on the `<img>` rather than the cell. With images off a client draws the alt string using the image's own styles, so the header still reads. Nothing in the picture is absent from the alt.

| | |
| --- | --- |
| Source | `_assets/logo-tankbag-email-horiz.png`, `…-dark.png` |
| Served | `public/img/` (the same bytes—`/img/*` is what the email points at, and a test asserts the two copies are identical) |
| Size | 360×103, ~6 KB each, displayed at 180×52 so the source is the 2x asset |

**Both are opaque, and that is load-bearing rather than incidental.** A transparent PNG vanishes wherever the client repaints the cell behind it. These carry their own ground—white and pure `#000`—so each is correct regardless of what a client does to the surrounding table. The consequence is that `DARK.cardBg` **must** be exactly `#000`: anything else paints a 180×52 rectangle of not-quite-the-right-black into the header, and `#0a0e11` against `#000` is 1.07:1, which is invisible on a laptop and obvious on an OLED phone in the dark. `test/email-dark-mode.test.ts` reads the PNG's actual corner pixel and fails if the two stop matching, so redrawing the asset on a different ground is caught rather than shipped.

Do **not** reach for `public/img/logo-tankbag-horiz-light@2x.png`—it is 2911×852 and 84 KB, an absurd payload for every inbox.

### Dark mode

Two populations, served by different mechanisms, and the split is what keeps "build light" above still true:

- **Clients that honour `prefers-color-scheme`** (Apple Mail on both platforms is the one that matters) get a real dark design from the `@media` block in `shell.tsx`.
- **Clients that do not** (Gmail everywhere—it applies its own inversion and ignores the query) get the light design and invert it cleanly, exactly as before.

So the light values stay inline and remain correct standalone, the dark ones exist **only** inside the media query, and that query overrides with `!important` because an author `!important` is the one thing that outranks an inline declaration. Nothing dark is load-bearing: delete the whole `<style>` block and every message is still correct.

Every primitive carries a `tb-` class, which is the only handle the media block has—an inline style cannot itself be conditional. **Adding a primitive means adding a rule for it**, or it renders dark-on-dark. That is a test, not a convention: `test/email-dark-mode.test.ts` fails on any `tb-` class in the document with no rule in the block, on any declaration missing `!important`, and on any dark palette value that leaks into an inline style.

The dark palette is in `DARK` in `theme.ts`, derived from the site's own dark-surface values in `_splash.scss` flattened over black rather than picked by eye, and contrast-checked in the same test. `$url` is **not** reusable in dark: `#1565c0` on black is 4.0:1, under the 4.5:1 a body-size link needs.

**Known gap:** Outlook.com's dark mode uses `[data-ogsc]` attribute rewriting rather than `prefers-color-scheme`, and nothing here targets it. Those readers get the light design, which is a correct outcome rather than a broken one—so this is untested territory to enter deliberately, not a bug to patch blind.

## Setting it up from scratch

Outside the repo, in this order:

1. **Resend**—add `tankbag.app`, put the SPF and DKIM records it gives you into Cloudflare DNS, wait for verification, create an API key. Domain management needs a **full access** key while the key that ends up in `SMTP_PASS` should be sending-only, so make a full-access one for setup and revoke it afterwards. A sending-only key returns `401 restricted_api_key` on every `/domains` call.
2. **DMARC**—add a TXT record at `_dmarc.tankbag.app`.
3. **Cloudflare Email Routing**—enable on `tankbag.app`, verify the destination inbox, route `hello@` and `no-reply@` to it. Do this even if only sending: replies to an address that hard-bounces hurt sender reputation.

Then set the five SMTP values in `.env`. They are already on the deploy allow-list in `utils/deploy/deploy.sh` and already forwarded in `docker-compose.prod.yml`, so no plumbing changes.

### What is actually deployed, as of 2026-08-07

Steps 1 and 2 are done. `tankbag.app` is verified in Resend, and the zone carries DKIM at `resend._domainkey`, SPF at `send`, and the SES bounce MX at `send`. A message from `hello@tankbag.app` reaches a Gmail inbox with `dkim=pass header.i=@tankbag.app`, `spf=pass` and `dmarc=pass header.from=tankbag.app`.

**DMARC is live as `v=DMARC1; p=none; rua=mailto:ziad@feralcreative.co`**, not the `p=quarantine` to `dmarc@tankbag.app` that step 2 implies. Both differences follow from step 3 being undone: with no Email Routing there is no `dmarc@tankbag.app` to deliver reports to, and `p=none` gathers those reports without quarantining mail from a domain whose alignment has a day of history behind it. Tighten to `quarantine` once the reports come back clean.

**Step 3 is outstanding, so the apex accepts no inbound mail at all**—there are no MX records on `tankbag.app` itself, and a reply to any notification hard-bounces. Worth closing before real riders start receiving mail.

Note also that SPF aligns in relaxed mode only: the envelope sender is on `send.tankbag.app` while the From header is the apex. That is DMARC's default and passes, but an `aspf=s` policy would fail SPF alignment and leave DKIM as the single passing mechanism.

## Checking it works

```bash
npm run typecheck && npm test
```

To send all four to a real inbox:

```bash
EMAIL_ASSET_ORIGIN=https://tankbag.app npx tsx utils/email-preview.mts [recipient]
```

**`EMAIL_ASSET_ORIGIN` is what makes the logo visible.** The wordmark's `<img src>` is built from `APP_ORIGIN`, which is `http://127.0.0.1:6686` in development—an address no inbox can reach—so without it every preview arrives with a broken header. Only `/img/` URLs are rewritten; the links in the body are left pointing at the dev origin, because those are being previewed too and silently aiming them at production would make a magic-link preview actively misleading. The script warns when the variable is unset and `APP_ORIGIN` is not https.

Then, against that inbox—none of the below is covered by the suite, which is pure-logic only:

1. Request a magic link and confirm the delivered body matches the copy of record.
2. Sign in with a fresh address by both methods. Two emails per signup; a second sign-in with the same address sends neither.
3. Approve the rider in `/admin`, then toggle `active → blocked → active` and confirm **no** second email.
4. Unset `SMTP_PASS`, restart, approve someone: the POST must succeed and the log must say `info … not configured`.
5. Read every template with **images disabled**, then in Outlook, Gmail dark mode on Android, and Apple Mail. Apple Mail is the one that exercises the dark design; Gmail exercises the light design surviving Gmail's own inversion. Check the header in both—a logo whose ground does not match the card behind it shows as a rectangle, and that is the failure this design is most exposed to.
6. In Gmail, "Show original" and confirm `SPF: PASS`, `DKIM: PASS`, `DMARC: PASS`.
7. Point `SMTP_HOST` at an unroutable address and approve someone. The process must log and stay up.
