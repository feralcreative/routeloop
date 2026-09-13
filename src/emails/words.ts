// What the app calls things, inside an email (#321).
//
// A template is pure and takes `words` as a PROP — the recipient's own, looked
// up by notify()/notifyMany() in src/notifications/service.ts beside their
// address, since only the sender knows who is being written to. A template
// rendered with no `words` (the registry test, a sender with no recipient
// profile) reads the motorcycle words, which is what every email said before.
import { DEFAULT_VOCAB, wordsFor, type Words } from '../views/vocab'

export type { Words }
export type WithWords = { words?: Words }

const DEFAULT_WORDS = wordsFor(DEFAULT_VOCAB)

export const wordsIn = (p: WithWords): Words => p.words ?? DEFAULT_WORDS
