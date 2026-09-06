const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Jira's CSV exporter writes dates as "DD/Mon/YY h:mm A" (e.g. "28/May/26
// 3:45 PM"), which `new Date(...)` cannot parse reliably. Returns an ISO
// 8601 string so downstream code (computeSignalsForIssues) never needs to
// know about Jira's export format.
export function parseJiraCsvDate(value: string): string | null {
  const match = /^(\d{2})\/(\w{3})\/(\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(value.trim());
  if (!match) return null;

  const [, day, monthAbbr, yearShort, hour12Str, minute, meridiem] = match;
  const month = MONTHS.findIndex((m) => m.toLowerCase() === monthAbbr.toLowerCase());
  if (month === -1) return null;

  const year = 2000 + Number(yearShort);
  let hour = Number(hour12Str) % 12;
  if (meridiem.toUpperCase() === "PM") hour += 12;

  const date = new Date(Date.UTC(year, month, Number(day), hour, Number(minute)));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
