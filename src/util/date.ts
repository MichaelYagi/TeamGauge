// Returns the machine's local calendar date as YYYY-MM-DD.
// `new Date().toISOString()` reports the UTC date, which is a day off from
// the local date for roughly half of every 24h cycle depending on timezone —
// wrong for "today" semantics like default snapshot/effective dates.
export function localToday(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
