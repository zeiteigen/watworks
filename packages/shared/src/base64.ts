/** Linear check. A grouped regex overflows V8's regexp stack on strings over about 4.4M characters, though not on Bun. */
export function isBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}
