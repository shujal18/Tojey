import React from 'react';
import { Text } from 'react-native';

// Emoji are rendered with the device's native color emoji font so they always keep
// their original palette. The json-level `color` (white on sent bubbles, gray on
// received, etc.) is NOT applied to emoji spans - a color-emoji glyph tinted by the
// bubble text color is exactly what makes it look faded or dark. Non-emoji text keeps
// the caller's color as before.
//
// Runs are grouped into grapheme clusters so multi-codepoint emoji (ZWJ families,
// skin tones, flags, ©️/®️/™️, 1️⃣ keycaps) stay inside a SINGLE <Text> node. Splitting
// a sequence across nested <Text> nodes breaks the ligature and can render partial or
// faded-looking glyphs on Android.

const VS16 = 0xfe0f;     // emoji variation selector
const ZWJ = 0x200d;      // zero width joiner
const ZWNJ = 0x200c;
const KEYCAP = 0x20e3;   // combining enclosing keycap
const isKeycapBaseCp = (cp) => (cp >= 0x30 && cp <= 0x39) || cp === 0x23 || cp === 0x2a; // 0-9 # *
const lastIsKeycapBase = (s) => {
  const t = String(s);
  return t.length > 0 && isKeycapBaseCp(t[t.length - 1].codePointAt(0));
};
const SKIN = (cp) => cp >= 0x1f3fb && cp <= 0x1f3ff;
const REGIONAL = (cp) => cp >= 0x1f1e6 && cp <= 0x1f1ff;
const TAG = (cp) => cp >= 0xe0020 && cp <= 0xe007f;
const MISC_EMOJI = new Set([0xa9, 0xae, 0x203c, 0x2049, 0x2122, 0x2139, 0x3030, 0x303d, 0x3297, 0x3299]);

function isEmojiCp(cp) {
  if (!cp) return false;
  return (
    (cp >= 0x1f000 && cp <= 0x1faff) ||
    (cp >= 0x2600 && cp <= 0x27bf) ||
    (cp >= 0x2b00 && cp <= 0x2bff) ||
    (cp >= 0x2e80 && cp <= 0x2eff) ||
    cp === VS16 || cp === ZWJ || cp === ZWNJ || cp === KEYCAP ||
    SKIN(cp) || REGIONAL(cp) || TAG(cp) || MISC_EMOJI.has(cp)
  );
}

export function emojiRuns(text) {
  const chars = Array.from(String(text == null ? '' : text));
  if (!chars.length) return [];
  const out = [];
  let curText = chars[0];
  let curEmoji = isEmojiCp(chars[0].codePointAt(0));
  for (let i = 1; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0);
    const prevCp = chars[i - 1].codePointAt(0);
    const prevPrevCp = chars[i - 2] ? chars[i - 2].codePointAt(0) : 0;
    const isEmoji = isEmojiCp(cp);
    let keep = false;
    if (curEmoji) {
      // An emoji run keeps going through continuations, modifiers and glue.
      keep = isEmoji || cp === VS16 || cp === ZWJ || cp === ZWNJ || SKIN(cp) || TAG(cp);
      if (!keep && REGIONAL(cp) && REGIONAL(prevCp)) keep = true;
      // c⃞ keycaps: pull the base digit (grabbed as its own text run right before
      // the VS16/keycap) back into this emoji run so it renders as one ligature.
      if (cp === KEYCAP && out.length) {
        const lastR = out[out.length - 1];
        if (!lastR.emoji && lastIsKeycapBase(lastR.text)) {
          const base = lastR.text[lastR.text.length - 1];
          lastR.text = lastR.text.slice(0, -1);
          curText = base + curText;
          if (!lastR.text) out.pop();
        }
      }
    } else if (!isEmoji) {
      // Plain text continues the current run.
      keep = true;
    } else {
      // Keycap/VS16 glue the preceding base digit/symbol back into the emoji run.
      const glued = (cp === KEYCAP && isKeycapBaseCp(prevCp))
        || (cp === VS16 && MISC_EMOJI.has(prevCp));
      if (glued) {
        curEmoji = true;
        keep = true;
      } else if (cp === ZWJ || cp === ZWNJ || SKIN(cp) || TAG(cp)) {
        // Rare malformed sequence; keep it glued so nothing extra is split out.
        keep = true;
      }
    }
    if (keep) {
      curText += chars[i];
    } else {
      out.push({ emoji: curEmoji, text: curText });
      curText = chars[i];
      curEmoji = isEmoji;
    }
  }
  out.push({ emoji: curEmoji, text: curText });
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