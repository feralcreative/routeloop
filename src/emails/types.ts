// The shape of an email.
//
// One definition produces three things — a subject, a plain-text body and an
// HTML body — because a message that exists only as HTML is unreadable to a text
// client and scores worse with spam filters, and one that exists only as text
// cannot carry the product's face. Both arms are required by the type, which is
// the entire enforcement mechanism: there is no way to add a template that
// forgets one.

export type Rendered = {
  subject: string
  text: string
  html: string
}

export type EmailTemplate<P> = {
  /**
   * Stable identifier. Used by the registry, the log line, the rate-limit
   * namespace and the golden-fixture filename, so renaming one is a visible
   * change rather than a silent one.
   */
  readonly key: string

  /** A function, not a string, so a subject can carry a value — an address, a count. */
  subject: (props: P) => string

  /**
   * The line most clients show after the subject in the message list.
   *
   * Authored, never derived from the body. The first line of a body is usually
   * a greeting, which is the least informative line in the message and exactly
   * what you do not want occupying the one piece of preview real estate.
   */
  preheader: (props: P) => string

  /**
   * The plain-text body, authored by hand.
   *
   * Deliberately NOT derived from the HTML. Deriving it needs a dependency,
   * produces text nobody would have chosen to write, and hides the one place
   * where the message has to work with no markup at all. The cost is about five
   * lines per email.
   */
  text: (props: P) => string

  /**
   * The body markup ONLY. `renderEmail()` supplies the doctype, the head, the
   * table scaffold, the header and the footer, so a template never repeats them
   * and cannot get them subtly different from its neighbours.
   */
  html: (props: P) => string

  /**
   * A representative props value.
   *
   * This is what makes the registry testable. `test/emails.test.ts` renders
   * every template without knowing any template's prop shape, which is only
   * possible because each one carries its own example. A template added without
   * one would not compile.
   */
  sample: P
}

/**
 * Identity function. Exists solely so `P` is inferred from `sample` at the
 * definition site, which is what lets a template be written without naming its
 * own props type twice.
 */
export const defineEmail = <P>(t: EmailTemplate<P>): EmailTemplate<P> => t

/**
 * A template with its prop type erased, for the registry.
 *
 * `EmailTemplate<unknown>` would not do: a `EmailTemplate<{url: string}>` is not
 * assignable to it, because the prop functions are contravariant in P. The
 * registry only ever calls a template with its OWN `sample`, so `any` here is
 * accurate about what is known rather than a shortcut around it.
 */
// biome-ignore lint/suspicious/noExplicitAny: see the comment above — variance, not laziness.
export type AnyEmailTemplate = EmailTemplate<any>
