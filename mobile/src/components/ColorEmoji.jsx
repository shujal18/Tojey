import React from 'react';
import { Text } from 'react-native';

const EMOJI_FONT = 'NotoColorEmoji';

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

export default function ColorEmoji({ children, style, numberOfLines, ...rest }) {
  const text = String(children == null ? '' : children);
  const runs = emojiRuns(text);
  return (
    <Text style={style} numberOfLines={numberOfLines} {...rest}>
      {runs.map((r, i) => (
        <Text key={i} style={r.emoji ? [style, { fontFamily: EMOJI_FONT }] : style}>
          {r.text}
        </Text>
      ))}
    </Text>
  );
}