// Which stage of release the site says it is in, and every phrase that follows
// from it.
//
// ONE SWITCH, NOT A SWEEP. The site said "closed alpha" in nine places across
// four kinds of file, and going to beta meant finding all nine — then finding
// them again for public beta. `RELEASE_STAGE` is the one line that changes, and
// this module is the one place a sentence about the stage is written, so the
// modal, the footer, the terms, the FAQ, and the pending page cannot disagree
// about what the app is.
//
// IT LIVES HERE AND NOT IN config.ts because it is a product decision rather
// than an environment: stage and prod are the same stage on the same day, and a
// deploy is the right ceremony for changing it. Being pure is also what lets
// test/stage.test.ts read it with no environment at all.
//
// THE CONTENT FILES TAKE THESE AS TOKENS through `content()`, the same way the
// FAQ takes its years, and a token is HTML — `content()` does not escape — so
// a phrase may carry <strong>. The release notes deliberately take none (see
// test/content.test.ts): their lede says "in beta", which is true of both beta
// stages, and the flip to public beta needs no edit there.
//
// WHAT "BETA" HOLDS AND "CLOSED" DOES NOT. The noun is stage-independent — the
// modal title, the profile hint, the FAQ's data-loss question and the terms'
// "provided as-is" all say beta and are written by hand. Only the sentences
// that turn on WHO CAN GET IN are here: phase, how accounts are made, and the
// sign-up answer. Public beta's wording is a best guess written today so the
// flip is one line and a read-through rather than a search.
export type ReleaseStage = 'closed-beta' | 'public-beta'

/** The stage the site is in. Change this line and deploy. */
export const RELEASE_STAGE: ReleaseStage = 'closed-beta'

export type StagePhrases = {
  /** "closed beta" — after "in a", in running text. */
  phase: string
  /** The terms' "which means …" clause, after the phase. A full clause, no period. */
  access: string
  /** The FAQ's answer to "Why can't I just sign up?", as HTML paragraphs. */
  signup: string
  /** The pending-approval page's second sentence, after "You're in the queue for beta testing." */
  pending: string
}

const PHRASES: Record<ReleaseStage, StagePhrases> = {
  'closed-beta': {
    phase: 'closed beta',
    access: 'accounts are approved by hand and things will break',
    signup:
      '<p>Because Routeloop isn’t ready for everyone yet. It’s in a <strong>closed beta</strong>, which is invite-only—riders I know, a few at a time. A public beta is the next step.</p>\n    <p>What you can do now is get on the list from the <a href="/login">join page</a>.</p>',
    pending:
      'Routeloop is in a closed beta right now—invite-only—and riders are waved in by hand, a few at a time. You’ll be able to sign in and start planning once yours comes up.',
  },
  'public-beta': {
    phase: 'public beta',
    access: 'anyone can make an account and things will still break',
    signup:
      '<p>You can. Routeloop is in a <strong>public beta</strong>: make an account from the <a href="/login">join page</a> and start planning.</p>',
    pending:
      'Routeloop is in a public beta and accounts are checked by hand before they open, usually within a day. You’ll be able to sign in and start planning once yours does.',
  },
}

/** The phrases for the current stage. */
export const stage = (s: ReleaseStage = RELEASE_STAGE): StagePhrases => PHRASES[s]

/** The tokens the content files carry for the stage, for `content()`. */
export const stageTokens = (s: ReleaseStage = RELEASE_STAGE) => ({
  STAGE_PHASE: PHRASES[s].phase,
  STAGE_ACCESS: PHRASES[s].access,
  STAGE_SIGNUP: PHRASES[s].signup,
})

export const RELEASE_STAGES = Object.keys(PHRASES) as ReleaseStage[]
