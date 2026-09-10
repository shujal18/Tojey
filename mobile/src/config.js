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
 * dependency-free dark PNG pattern tile so chats always have a proper dark
 * backdrop. Empty string falls back to the plain solid color.
 */
export const CHAT_BACKGROUND =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAHgAAAB4CAYAAAA5ZDbSAAACi0lEQVR42u3dTW7CMBAGUA4QsUBdRCw4SW+TbU+Sm/YUqSK1G0QKJMHM2G/xLRHGDzvO3/hwOvWT1JuDTgAsgAWwABbAAliaBh6HqQcMGDDgyoHHYboALtbmC2DAgAE/8EVL+fr8PmXIDJyknYt9XWwEZ0HNCHyN/ZYpGjBgwFmBM+JmBZ4DGHAZ4OgdmLV9oUZw5E7M2rZwU3TUjszarpDH4KzHu4h/urCLLMj79E/oVTTk7f0S/jQpCvI4TF3GtUCK8+ASyDPg1kRc6KW50PEK5D1QS2Gv/f2prmT9/sjj1rwS9gb0Hu3tW7lUeVyLXBJ1T+ytM1c64Ky4G0c04OiwG6EBZ8JdgQw4G+6TyICzwT4JDTgz7gPIbQPXgHsHGTDgSoFrwv0HuU3gGnEXkNsDrhn3BjJgwBUBt4B7hXxq6W5S11oAAwYMOMcTHV2rAQw4/UN3XesBDBgw4JgPvneyDhkwYMCAAQMGDBgwYAEMuAzw/Fbc2sB9HHlLPxvBRjBgwIABAwYMFzBgwIABA/ZEhyc6AAMGDBiyB98BezfJu0mAAQMG7A1/b/ir0aFGB2DA6mSpdKfSnVqValUCBqxetHrRKr6r+G7PBns22HWlZuBxmM72Taob+MPOZxUCz7DXsXdh5cB7bTGb5VbfHlvrhgOej7kLuH852z+43inaDuCAX/cHeOf3r0UOvYr+LTXwEaFjI+UZ5MgjuL9xHixPIocE3mu1DDnmKrrPPi1Galco4MgjN2vbwgBHn5azti/b3STA0c+Dx2G6AC7W5gtgwIABP4C6FMD7oy6l2Ahe+9l35l511qBtfs8UDRgw4KzAWZMReEsAAwYMGDBgASyABbAABiyAJUd+ACfqss0sPTeAAAAAAElFTkSuQmCC";
