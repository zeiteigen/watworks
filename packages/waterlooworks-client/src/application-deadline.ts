const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const toronto = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function wallTime(timestamp: number): number {
  const parts = Object.fromEntries(toronto.formatToParts(timestamp).map(part => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
}

/** WaterlooWorks displays Ontario local times; never use the execution host timezone. */
export function applicationDeadline(value: string | undefined): string {
  if (!value) return "";
  if (/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  const match = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}) (AM|PM)$/.exec(value.trim());
  if (!match) return "";
  const hour = Number(match[4]); const minute = Number(match[5]);
  if (hour < 1 || hour > 12 || minute > 59) return "";
  const wall = Date.UTC(Number(match[3]), months.indexOf(match[1]!), Number(match[2]), hour % 12 + (match[6] === "PM" ? 12 : 0), minute);
  const date = new Date(wall);
  if (date.getUTCMonth() !== months.indexOf(match[1]!) || date.getUTCDate() !== Number(match[2])) return "";
  // Check offsets on both sides of a transition. A gap has no candidate;
  // an autumn repeated hour has two and must not be guessed.
  const candidates = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const sample = wall + hours * 3_600_000;
    const utc = wall - (wallTime(sample) - sample);
    if (wallTime(utc) === wall) candidates.add(utc);
  }
  return candidates.size === 1 ? new Date([...candidates][0]!).toISOString() : "";
}
