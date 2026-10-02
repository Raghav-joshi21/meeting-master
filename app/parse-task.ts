// Quick-add parser: pulls a due date/time, @owner and !priority out of a typed
// task, e.g. "setup lunch at moon on monday 12:00 @priya !urgent".
// Runs locally and instantly; no AI call.

export type QuickTask = {
  task: string;
  due: string; // human label, e.g. "Mon, Oct 5 · 12:00 PM"
  dueAt?: number; // timestamp, when a date was found
  owner?: string;
  priority?: 'high' | 'medium' | 'low';
};

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
};

const PREP = String.raw`(?:(?:on|by|at|due|before|this)\s+)?`;
const WEEKDAY_RE = new RegExp(String.raw`\b${PREP}(?:next\s+)?(${Object.keys(WEEKDAYS).join('|')})\b\.?`, 'i');
const RELDAY_RE = new RegExp(String.raw`\b${PREP}(day after tomorrow|today|tonight|tomorrow|tmrw|tmr)\b`, 'i');
const MONTH_NAMES = Object.keys(MONTHS).join('|');
const DATE_RE = new RegExp(
  String.raw`\b${PREP}(?:(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_NAMES})\b\.?|(${MONTH_NAMES})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b)`,
  'i',
);
const IN_DAYS_RE = /\bin\s+(\d{1,2})\s+(days?|weeks?)\b/i;
const NEXT_WEEK_RE = /\b(?:by\s+|on\s+)?next\s+week\b/i;
const TIME_RE =
  /\b(?:at\s+|@\s*|by\s+)?((?:[01]?\d|2[0-3])[:.][0-5]\d\s*(?:am|pm|a\.m\.|p\.m\.)?|(?:1[0-2]|0?[1-9])\s*(?:am|pm|a\.m\.|p\.m\.)|noon|midnight)(?![\w:])/i;
// "at 12" / "at 3" with no am/pm or minutes (only after "at", so plain numbers are left alone)
const BARE_HOUR_RE = /\bat\s+(1[0-2]|[1-9])(?![\w:.])/i;
const OWNER_RE = /(?:^|\s)@([a-z][\w.-]*)/i;
const PRIORITY_RE = /(?:^|\s)(!{1,3}(?:urgent|high|asap|medium|normal|low|later)?|\burgent\b|\basap\b)(?=\s|$)/i;

function parseTime(raw: string): { h: number; m: number } | null {
  const t = raw.toLowerCase().replace(/\./g, ':').replace(/\s+/g, '');
  if (t === 'noon') return { h: 12, m: 0 };
  if (t === 'midnight') return { h: 0, m: 0 };
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?(am|pm|a:m:|p:m:)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.[0];
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  return h < 24 && min < 60 ? { h, m: min } : null;
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export function parseQuickTask(input: string, now = new Date()): QuickTask {
  let text = ` ${input.trim()} `;
  const cut = (re: RegExp) => {
    const m = text.match(re);
    if (m) text = text.replace(m[0], ' ');
    return m;
  };

  // owner / priority
  const ownerM = cut(OWNER_RE);
  const prioM = cut(PRIORITY_RE);
  let priority: QuickTask['priority'];
  if (prioM) {
    const p = prioM[1].toLowerCase();
    priority = /low|later/.test(p) ? 'low' : /medium|normal/.test(p) ? 'medium' : 'high';
  }

  // date
  let day: Date | undefined;
  let m: RegExpMatchArray | null;
  if ((m = cut(RELDAY_RE))) {
    const w = m[1].toLowerCase();
    const add = w === 'day after tomorrow' ? 2 : w.startsWith('tom') || w.startsWith('tm') ? 1 : 0;
    day = startOfDay(now);
    day.setDate(day.getDate() + add);
  } else if ((m = cut(DATE_RE))) {
    const d = Number(m[1] ?? m[4]);
    const mon = MONTHS[(m[2] ?? m[3]).toLowerCase()];
    day = new Date(now.getFullYear(), mon, d);
    if (day < startOfDay(now)) day.setFullYear(day.getFullYear() + 1); // "Jan 5" in December means next year
  } else if ((m = cut(WEEKDAY_RE))) {
    const target = WEEKDAYS[m[1].toLowerCase().replace(/\.$/, '')];
    day = startOfDay(now);
    let diff = (target - day.getDay() + 7) % 7;
    // Naming today's weekday usually means next week ("by Thursday" said on a Thursday), unless "this".
    if (diff === 0 && !/this/i.test(m[0])) diff = 7;
    day.setDate(day.getDate() + diff);
  } else if ((m = cut(IN_DAYS_RE))) {
    day = startOfDay(now);
    day.setDate(day.getDate() + Number(m[1]) * (/week/i.test(m[2]) ? 7 : 1));
  } else if (cut(NEXT_WEEK_RE)) {
    day = startOfDay(now);
    day.setDate(day.getDate() + ((8 - day.getDay()) % 7 || 7)); // next Monday
  }

  // time
  const timeM = cut(TIME_RE);
  let time = timeM ? parseTime(timeM[1]) : null;
  if (!time) {
    const bare = cut(BARE_HOUR_RE);
    if (bare) {
      const h = Number(bare[1]);
      time = { h: h === 12 ? 12 : h <= 6 ? h + 12 : h, m: 0 }; // at 12 = noon, 1-6 = afternoon, 7-11 = morning
    }
  }
  if (time && !day) {
    // time only: today, or tomorrow if that time has passed
    day = startOfDay(now);
    if (time.h * 60 + time.m <= now.getHours() * 60 + now.getMinutes()) day.setDate(day.getDate() + 1);
  }
  // same-day weekday whose time already passed → next week
  if (day && time && /\b(mon|tue|wed|thu|fri|sat|sun)/i.test(input) && !RELDAY_RE.test(input)) {
    const at = new Date(day);
    at.setHours(time.h, time.m);
    if (at < now) day.setDate(day.getDate() + 7);
  }

  let dueAt: number | undefined;
  let due = '';
  if (day) {
    const at = new Date(day);
    if (time) at.setHours(time.h, time.m, 0, 0);
    dueAt = at.getTime();
    const dateLabel = at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const timeLabel = time ? at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
    due = timeLabel ? `${dateLabel} · ${timeLabel}` : dateLabel;
  }

  // tidy the remaining text
  let task = text
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;])/g, '$1')
    .trim()
    .replace(/[\s,;-]+$/, '')
    .replace(/\s+\b(on|at|by|due|before|for)$/i, '')
    .trim();
  task = task.charAt(0).toUpperCase() + task.slice(1);

  return {
    task: task || input.trim(),
    due,
    dueAt,
    owner: ownerM ? ownerM[1].charAt(0).toUpperCase() + ownerM[1].slice(1) : undefined,
    priority,
  };
}
