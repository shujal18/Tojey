import React, { useState } from 'react';
import { Image, Text } from 'react-native';

// Emoji are rendered as Twemoji PNGs (bright, consistent palette) instead of the
// device's emoji font, which on some OEMs (OPPO / ColorOS) falls back to a
// monochrome/dark system emoji font inside <Text> that makes emoji look faded or
// solid-black. Rendering images guarantees the original colorful glyphs.
//
// Runs are grouped into grapheme clusters so multi-codepoint emoji (ZWJ families,
// skin tones, flags, ©️/®️/™️, 1️⃣ keycaps) stay intact. Splitting a sequence breaks
// the ligature and can render partial or faded-looking glyphs.
const EMOJI_BASE = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/';

// Fallback font (bundled android/app/src/main/assets/fonts/NotoColorEmoji.ttf) is
// used ONLY if a Twemoji image fails to load. It must never be applied to
// non-emoji spans (they would render as tofu boxes).
const EMOJI_FONT = 'NotoColorEmoji';

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

// Split a single emoji run into individual grapheme clusters (one Twemoji image each).
function splitEmoji(s) {
  const chars = Array.from(s);
  if (!chars.length) return [];
  const out = [];
  let cur = chars[0];
  for (let i = 1; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0);
    const prev = chars[i - 1].codePointAt(0);
    let glueWithPrev = false;
    if (cp === VS16 || cp === ZWJ || cp === ZWNJ || SKIN(cp) || TAG(cp)) glueWithPrev = true;
    else if (cp === KEYCAP && (isKeycapBaseCp(prev) || prev === VS16)) glueWithPrev = true;
    else if (REGIONAL(cp) && REGIONAL(prev)) glueWithPrev = true;
    else if (MISC_EMOJI.has(cp) && prev === VS16) glueWithPrev = true;
    if (glueWithPrev) cur += chars[i];
    else { out.push(cur); cur = chars[i]; }
  }
  out.push(cur);
  return out;
}

// Twemoji filenames are lowercase hex codepoints joined by '-'. Variation selectors
// (…-fe0f) are usually omitted from the filename, but a few sequences keep them
// (text-default bases inside ZWJ sequences, e.g. 🚴♀️ = …-2640-fe0f). Try the
// "stripped" form first, then the "kept" form, then fall back to the native font.
function twemojiCandidates(cluster) {
  const hex = Array.from(cluster).map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('-');
  const stripped = Array.from(cluster)
    .map((c) => c.codePointAt(0))
    .filter((cp) => cp !== VS16 && cp !== ZWNJ)
    .map((cp) => cp.toString(16).padStart(4, '0'))
    .join('-');
  const out = [stripped];
  if (stripped !== hex) out.push(hex);
  return out.map((p) => EMOJI_BASE + p + '.png');
}

const EmojiImg = React.memo(function EmojiImg({ cluster, size, fallbackStyle, candidates }) {
  const [idx, setIdx] = useState(0);
  if (idx >= candidates.length) {
    return <Text style={fallbackStyle}>{cluster}</Text>;
  }
  return (
    <Image
      source={{ uri: candidates[idx] }}
      onError={() => setIdx(idx + 1)}
      style={{ width: size, height: size }}
      resizeMode="contain"
      fadeDuration={0}
      accessible={false}
    />
  );
});

function flatten(style) {
  if (Array.isArray(style)) return Object.assign({}, ...style);
  return { ...(style || {}) };
}

export default function ColorEmoji({ children, style, numberOfLines, ...rest }) {
  const text = String(children == null ? '' : children);
  const runs = emojiRuns(text);
  const base = flatten(style);
  const { color, ...baseNoColor } = base;
  const fontSize = parseFloat(base.fontSize) || 14;
  const lineHeight = base.lineHeight != null ? parseFloat(base.lineHeight) || 0 : 0;
  let emojiPx = Math.round(fontSize * 1.08);
  if (lineHeight > 0 && emojiPx > lineHeight) emojiPx = Math.max(1, Math.round(lineHeight * 0.96));
  const fallbackStyle = [baseNoColor, { fontFamily: EMOJI_FONT, fontWeight: '400' }];
  return (
    <Text style={color != null ? baseNoColor : base} numberOfLines={numberOfLines} {...rest}>
      {runs.map((r, i) =>
        r.emoji
          ? splitEmoji(r.text).map((cluster, j) =>
              cluster ? (
                <EmojiImg key={`${i}-${j}`} cluster={cluster} size={emojiPx} fallbackStyle={fallbackStyle} candidates={twemojiCandidates(cluster)} />
              ) : null
            )
          : <Text key={i} style={color != null ? [baseNoColor, { color }] : base}>{r.text}</Text>
      )}
    </Text>
  );
}