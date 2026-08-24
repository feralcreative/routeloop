// What build a rider is looking at.
//
// **The version is a property of the COMMIT, not of the deploy**, and that is
// what makes it reproducible: deploying the same commit twice reports the same
// version, because it is the same code. A scheme keyed on deploy count would
// say otherwise and be lying.
//
// The shape is `YYYY-MM-DD-HHMMPT` — Ziad's call, 2026-08-23. Date-based because
// the question a beta tester actually asks is "is this newer than the one I
// found that bug in", and a date answers it without them learning what our minor
// version means. The time is the same answer at a finer grain: on a day with
// four deploys, a sequence counter tells a rider which build came later but a
// clock tells them how long ago, which is the thing they were really asking.
//
// It is the COMMIT's minute, so it is derived rather than stored and there is no
// state anywhere that can drift.
//
// `PT` is part of the string, not decoration. A bare timestamp gets read in the
// reader's own zone, and a tester a few hours ahead would place the build they
// are running in the future. `PT` and not `PDT`/`PST` because the zone database
// already swaps those and the half of the year is not what is being said.
//
// Computed by utils/deploy/deploy.sh and shipped as APP_VERSION. There is no
// fallback to running `git` here: this module is imported by the request path
// and spawning a subprocess per boot inside a container to recover a string we
// already know at build time would be worse than saying "dev".
const RAW = (process.env.APP_VERSION ?? '').trim()

/** The build's version, or `dev` when nothing stamped one — which is every local run. */
export const APP_VERSION = RAW === '' ? 'dev' : RAW

/** True for a local or unstamped build. Surfaces are free to render this differently. */
export const IS_DEV_BUILD = APP_VERSION === 'dev'

// The commit, for a bug report that needs to name an exact tree. Deliberately
// NOT shown beside the version: a rider does not need it, and a hex string next
// to a date invites them to quote the wrong one. It rides in a title attribute
// and in the feedback diagnostics.
export const BUILD_SHA = (process.env.BUILD_SHA ?? '').trim()

/**
 * The version as a rider sees it.
 *
 * `v` is not prefixed — the string is a date and `v2026-08-23-1834PT` reads like
 * a major version 2026. The word "Version" belongs to whatever labels this, not
 * to the value.
 */
export const versionLabel = (): string => APP_VERSION
