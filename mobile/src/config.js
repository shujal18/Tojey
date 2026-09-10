/**
 * Tojey backend configuration.
 *
 * Set SERVER_URL to your deployed Render backend URL.
 * Current live backend: https://tojey.onrender.com
 */
export const SERVER_URL = "https://tojey.onrender.com";

export function absUrl(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) return SERVER_URL + url;
  return url;
}

/**
 * Chat wallpaper. Bundled asset (metro) shown behind the message list AND the
 * bottom composer area; always cover-fitted so it never stretches or distorts.
 * A subtle dark overlay (in the chat screen) keeps text readable over any image.
 */
export const CHAT_BACKGROUND = require("./assets/chat-wallpaper.jpg");

/** Default sheet color if the wallpaper fails to decode. */
export const CHAT_FALLBACK_BACKGROUND = "#0d0f12";
