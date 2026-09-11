// On Android the platform renders a Text node whose content is *only* emoji
// with a monochrome fallback font. Appending a zero-width space (U+200B) makes
// the string "not pure emoji" so the color emoji font (NotoColorEmoji) is used,
// while remaining invisible in layout.
export function emojiSpan(s) {
  return `${s}\u200B`;
}