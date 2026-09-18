// "Is this a phone?", asked of the request and answered without a database, so
// test/device.test.ts can pin it. ONE READER: the `/` route, which sends a
// phone to /rides (Ziad's call, 2026-09-17 — the job on a phone is to look up
// a planned ride and load it, and the dashboard is the numbers). Nothing else
// should branch on this; the phone pass is responsive at the same URLs (#360),
// and a second reader is a second layout decided from a User-Agent.
//
// TWO SIGNALS, EITHER ONE ENOUGH. `Sec-CH-UA-Mobile: ?1` is a low-entropy
// client hint every Chromium browser sends unasked and is the honest answer
// where it exists; Safari sends no hints at all, so the User-Agent is read as
// the fallback. A phone is something that says so: iPhone and iPod name
// themselves, Android carries a literal `Mobile` token on a phone and not on a
// tablet, and Windows Phone still exists somewhere. An iPad claims to be a Mac
// since iPadOS 13 and is treated as one here, which is right — it has a
// desktop's width — and an Android tablet lacks the token for the same reason.
//
// A MISS IS THE DASHBOARD, NOT THE LIST. A desktop browser has no cost from
// this being wrong in either direction, and a phone this fails to recognize
// still has /rides one tap away in the menu — where a desktop wrongly called a
// phone would lose the dashboard from its own address.
const PHONE_UA = /\biPhone\b|\biPod\b|\bWindows Phone\b|\bAndroid\b.*\bMobile\b/i

export function isPhone(header: (name: string) => string | undefined | null): boolean {
  const hint = header('sec-ch-ua-mobile')
  if (hint != null && hint.trim() !== '') return hint.trim() === '?1'
  return PHONE_UA.test(header('user-agent') ?? '')
}
