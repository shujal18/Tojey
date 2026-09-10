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
 * Chat message-area background. Set to a URL/`require('...')` of the supplied
 * dark gaming-pattern image to use the real asset. The default is a subtle,
 * dependency-free dark pattern (data-URI SVG tile) so chats always have a
 * proper dark backdrop. Empty string falls back to the plain solid color.
 */
export const CHAT_BACKGROUND =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140">' +
    '<rect width="140" height="140" fill="#121218"/>' +
    '<g stroke="#8a63ff" stroke-opacity="0.10" stroke-width="1" fill="none">' +
    '<path d="M0 0h140v140H0z"/>' +
    '<path d="M14 14h112v112H14z"/>' +
    '<path d="M28 28h84v84H28z"/>' +
    '<circle cx="70" cy="70" r="50"/><circle cx="70" cy="70" r="34"/><circle cx="70" cy="70" r="18"/>' +
    '</g>' +
    '<g stroke="#6C3CE9" stroke-opacity="0.16" stroke-width="1" fill="none">' +
    '<path d="M70 4v12M70 124v12M4 70h12M124 70h12"/>' +
    '<path d="M18 18l8 8M114 114l8 8M18 122l10-10M114 18l10 10"/>' +
    '<rect x="62" y="8" width="16" height="6"/><rect x="62" y="126" width="16" height="6"/>' +
    '<rect x="8" y="62" width="6" height="16"/><rect x="126" y="62" width="6" height="16"/>' +
    '</g>' +
    '</svg>'
  );
