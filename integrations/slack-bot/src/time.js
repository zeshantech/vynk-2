// Pure helpers for durations and dates (no I/O), so they're easy to test.

export const MAX_HOURS_PER_ENTRY = 24;
export const MAX_HOURS_PER_DAY = 24;

// 2 | 1.5 | 2h | 1.5h | 45m | 1h30m | 1h 30m | 1:30
const DURATION_PATTERN =
  /^(?:(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:h|hr|hrs|hours?)?|(\d{1,2})\s*(?:h|hr|hrs)\s*(\d{1,2})\s*(?:m|min|mins)?|(\d{1,4})\s*(?:m|min|mins|minutes?)|(\d{1,2}):([0-5]\d))$/i;

/** Duration text -> hours (number), or null when the format is not recognised. */
export function parseHours(input) {
  const match = String(input ?? "")
    .trim()
    .match(DURATION_PATTERN);
  if (!match) return null;
  const [, decimal, h, m, minutesOnly, clockH, clockM] = match;
  if (m !== undefined && Number(m) > 59) return null;
  let hours;
  if (decimal !== undefined) hours = Number(decimal.replace(",", "."));
  else if (h !== undefined) hours = Number(h) + Number(m) / 60;
  else if (minutesOnly !== undefined) hours = Number(minutesOnly) / 60;
  else hours = Number(clockH) + Number(clockM) / 60;
  return hours > 0 ? Math.round(hours * 100) / 100 : null;
}

/** Why a duration is not allowed, or null when it is fine. */
export function hoursError(input) {
  const hours = parseHours(input);
  if (hours === null) return "Use a duration like 2h, 1h30m, 45m or 1.5";
  if (hours < 1 / 60) return "Minimum is 1 minute";
  if (hours > MAX_HOURS_PER_ENTRY) return `Maximum is ${MAX_HOURS_PER_ENTRY}h per entry`;
  return null;
}

/** 2.5 -> "PT2H30M" (ISO 8601 duration that OpenProject expects). */
export function toIsoDuration(hours) {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `PT${h ? `${h}H` : ""}${m ? `${m}M` : ""}` || "PT0H";
}

/** "PT2H30M" / "P1DT2H" -> hours as a number. */
export function fromIsoDuration(iso) {
  const match = String(iso ?? "").match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!match) return 0;
  const [, d, h, m, s] = match.map((v) => Number(v ?? 0));
  return d * 24 + h + m / 60 + s / 3600;
}

export function formatHours(hours) {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (!h && !m) return "0h";
  return [h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ");
}

/** Today's date (YYYY-MM-DD) in the given IANA time zone. */
export function todayIn(timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "today" | "yesterday" | "YYYY-MM-DD" -> YYYY-MM-DD (null if invalid). */
export function resolveDate(word, timeZone) {
  const today = todayIn(timeZone);
  if (!word || word === "today") return today;
  if (word === "yesterday") return addDays(today, -1);
  return /^\d{4}-\d{2}-\d{2}$/.test(word) ? word : null;
}

/** Monday..Sunday of the week containing isoDate. */
export function weekContaining(isoDate) {
  const weekday = new Date(`${isoDate}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const monday = addDays(isoDate, -((weekday + 6) % 7));
  return { from: monday, to: addDays(monday, 6), days: [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(monday, i)) };
}

/** Monday..Sunday of the current week (weeksBack=1 for last week) in the given time zone. */
export function currentWeek(timeZone, weeksBack = 0) {
  return weekContaining(addDays(todayIn(timeZone), -7 * weeksBack));
}
