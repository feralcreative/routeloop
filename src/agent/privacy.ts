// What may reach a model provider (Anthropic or OpenAI, or the rider's own MCP
// client), field by field (#452). Ziad's call, 2026-10-31: an allowlist.
//
// Every agent tool that returns rider data draws its fields from SENT and nothing
// else; a field in ON_REQUEST only goes out through an owner-only tool the rider's
// own question triggers; a field in NEVER does not go out at all. src/content/
// privacy.html says what SENT and ON_REQUEST mean in plain words, and changes in
// the same commit as this file. test/agent-foundations.test.ts holds the summary to it.
//
// PURE.

/** Sent whenever a tool needs it. */
export const SENT = [
  'ride: title, description, routes, points (name, address, position, categories, dwell, public notes), times, distances',
  'ride: group names and how many riders are in each, never who',
  'ride: the creator’s private stop notes, to the creator’s own assistant only (canSeeDetails)',
  'bikes: label, fuel range, comfort range, fuel type, of the bikes riding this ride',
  'rider: units, clock, date format, stop-by time, favor and avoid place lists',
  'rider: the trip brief stored on the ride (#456)',
  'road reports: kind, note, dates, and seasonal window, never who filed it',
] as const

/** Only through an owner-only tool, when the creator asks about it. */
export const ON_REQUEST = [
  'ride: the private stop record beyond notes (confirmation number, check-in and check-out, phone, address, links)',
] as const

/** Never sent to a model provider by any tool. */
export const NEVER = [
  'any rider’s email address, name, or handle other than the asking rider’s own',
  'the roster: who is invited, who said yes, placeholders and their personal links',
  'a rider’s home base from their profile (a ride’s own points go out as the ride shows them)',
  'payment handles and phone numbers on profiles',
  'stored API keys, OAuth tokens, and session data',
] as const
