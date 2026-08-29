// The interpunct used as a data delimiter, and the space around it.
//
// It appears on about twenty surfaces — ride cards, the dashboard hero, the
// roadbook, the timeline readout, the admin and feedback lists — always between
// two facts rather than inside a sentence. Ziad likes the character; what it did
// not have was room. A word space either side is what the source happened to
// carry, and in at least one place (the dashboard hero) JSX had eaten one of the
// two, so the line read "413 hours riding* ·Twisty overall".
//
// **AN EN SPACE, NOT A WORD SPACE, AND NOT TWO WORD SPACES.** U+2002 is exactly
// half an em at whatever size it lands in, so the gap scales with the type
// instead of being fixed by whatever the font decided a space is. Two adjacent
// ASCII spaces would not have worked at all: HTML collapses a run of them to
// one, which is what makes "add more space" in markup a thing that silently does
// nothing. U+2002 is not in HTML's collapsible set, so it survives — and it is
// still a BREAKING space, which is wanted here: a long meta line should wrap at
// its delimiters rather than overflow.
//
// **WRITTEN AS AN ESCAPE, NEVER AS THE RAW CHARACTER.** Same rule AGENTS.md
// gives for U+00A0: an invisible character in source is unreviewable in a diff
// and undetectable when something strips it. The interpunct itself is visible
// and stays literal.
//
// Mirrored by SEP in public/js/builder.js and public/js/viewer.js, which build
// the same strings in the browser; test/sep.test.ts holds the three together.
// One value to change, and changing it moves every surface at once.
export const SEP = '\u2002\u00b7\u2002'
