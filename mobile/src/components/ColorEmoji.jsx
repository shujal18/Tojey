import React from 'react';
import { Text } from 'react-native';

// Emoji are rendered with the device's native color emoji font so they always keep
// their original palette. The json-level `color` (white on sent bubbles, gray on
// received, etc.) is NOT applied to emoji spans - a color-emoji glyph tinted by the
// bubble text color is exactly what makes it look faded or dark. Non-emoji text keeps
// the caller's color as before.
function isEmojiCp(cp) {
  if (!cp) return false;
  return (
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x2b00 && cp <= 0x2bff) ||
    (cp >= 0x2e80 && cp <= 0x2eff) ||
    cp === 0xfe0f ||
    cp === 0x200d ||
    cp === 0x20e3
  );
}

export function emojiRuns(text) {
  const chars = Array.from(String(text == null ? '' : text));
  if (!chars.length) return [];
  const out = [];
  let cur = { emoji: isEmojiCp(chars[0].codePointAt(0)), text: '' };
  for (const ch of chars) {
    const isEmoji = isEmojiCp(ch.codePointAt(0));
    if (isEmoji === cur.emoji) {
      cur.text += ch;
    } else {
      out.push(cur);
      cur = { emoji: isEmoji, text: ch };
    }
  }
  out.push(cur);
  return out;
}

function flatten(style) {
  if (Array.isArray(style)) return Object.assign({}, ...style);
  return { ...(style || {}) };
}

export default function ColorEmoji({ children, style, numberOfLines, ...rest }) {
  const text = String(children == null ? '' : children);
  const runs = emojiRuns(text);
  const base = flatten(style);
  const { color, ...baseNoColor } = base;
  return (
    <Text style={color != null ? baseNoColor : base} numberOfLines={numberOfLines} {...rest}>
      {runs.map((r, i) =>
        r.emoji
          ? <Text key={i} style={baseNoColor}>{r.text}</Text>
          : <Text key={i} style={color != null ? [baseNoColor, { color }] : base}>{r.text}</Text>
      )}
    </Text>
  );
}