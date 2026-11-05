/** Session cookies have no expiry (or Playwright's -1 sentinel). */
export function unexpiredCookie(cookie: { expires?: number | undefined }, now = Date.now()): boolean {
  return cookie.expires === undefined || cookie.expires === -1 || cookie.expires * 1000 > now;
}
