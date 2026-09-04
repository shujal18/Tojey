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
