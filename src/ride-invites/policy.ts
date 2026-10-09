// A personal ride link (#428), the rules half. Pure, so test/ride-invites.test.ts
// reaches it with no database; the queries are in ./service.ts.
//
// THE LINK IS THREE THINGS IN ORDER OF HOW FAR THE PERSON GOES: it lets them see
// and download the ride, it lets them join Routeloop and land on it, and it lets
// them say no. Joining is optional — somebody who only wants the GPX never has to
// make an account.

/** The fields the liveness rule reads. */
export type InviteFacts = {
  sentAt: Date | null
  redeemedAt: Date | null
  declinedAt: Date | null
  revokedAt: Date | null
}

/** Why a link does nothing any more. `unsent` is a draft's row, whose token has
 *  not been minted — it cannot be reached by a link at all, and is here so the
 *  rule is total. */
export type InviteLiveness = 'ok' | 'unsent' | 'joined' | 'declined' | 'revoked'

/**
 * Whether a link still works. Live is SENT and nothing since: once the person
 * has joined, their account is the way in and the link would be a second one;
 * once they have declined, the organizer has their answer; once revoked, the
 * organizer took it back.
 */
export function inviteLiveness(i: InviteFacts): InviteLiveness {
  if (i.revokedAt) return 'revoked'
  if (i.declinedAt) return 'declined'
  if (i.redeemedAt) return 'joined'
  if (!i.sentAt) return 'unsent'
  return 'ok'
}

export const isLiveInvite = (i: InviteFacts): boolean => inviteLiveness(i) === 'ok'

/** The path a personal link opens. A PATH and not a URL, so the email and the
 *  page agree on it and APP_ORIGIN is added in exactly one place. */
export const rideInvitePath = (token: string): string => `/ride-invite/${token}`

/**
 * How many personal links one browser's view cookie carries. Somebody invited to
 * a handful of rides by a handful of organizers holds a handful of tokens; the
 * cap keeps a cookie that has been appended to forever from growing past what a
 * header may carry, and the oldest falls off first.
 */
export const MAX_VIEW_TOKENS = 12

/** Add a token to the view cookie's list, newest last, deduplicated, capped. */
export function withViewToken(current: readonly string[], token: string): string[] {
  const next = current.filter((t) => t !== token)
  next.push(token)
  return next.slice(-MAX_VIEW_TOKENS)
}

/** The cookie's value, split. Each entry is checked by the caller against the
 *  token charset before it is hashed — a cookie is attacker-supplied. */
export const parseViewTokens = (raw: string): string[] =>
  raw
    .split('.')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(-MAX_VIEW_TOKENS)

export const serializeViewTokens = (tokens: readonly string[]): string => tokens.join('.')
