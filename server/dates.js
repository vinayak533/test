/* ============================================================================
   server/dates.js — deterministic stay-date extraction.

   Jev classifies; it does not pull spans out of text. Dates are therefore
   read here with plain rules, so "tonight" means the same thing every time
   and a test can pin it down.

   Conventions
     * Every date is a calendar day "YYYY-MM-DD" in the hotel's timezone.
     * check_in is the first night, check_out the departure morning
       (exclusive). One night = check_out is the day after check_in.
     * Numeric dates are day-first (20/10 = 20 October), as written in India.
     * A day and month with no year means the next time that date comes round.
   ============================================================================ */

"use strict";

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12
};
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const ORD = "(?:st|nd|rd|th)?";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WORD_NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

/* ---- civil-date arithmetic, all in UTC so DST never shifts a day ------- */

function iso(y, m, d){
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}
function addDays(day, n){
  const dt = new Date(day + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
function diffDays(a, b){
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}
function weekday(day){ return new Date(day + "T00:00:00Z").getUTCDay(); }

function todayIn(timeZone, now = new Date()){
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/* A day/month with no year: this year, or next year once it has passed. */
function nextOccurrence(today, month, day){
  const y = Number(today.slice(0, 4));
  const thisYear = iso(y, month, day);
  if (thisYear && thisYear >= today) return thisYear;
  return iso(y + 1, month, day) || thisYear;
}

function fullYear(y){ return y < 100 ? 2000 + y : y; }

/* ---- extraction --------------------------------------------------------- */

/* Finds explicit calendar dates in reading order. Each match is blanked out
   of the working string so a later, looser pattern cannot re-read it. */
function explicitDates(s, today){
  const found = [];
  let work = s;
  const take = (re, build) => {
    work = work.replace(re, (m, ...g) => {
      const index = g[g.length - 2];
      const days = build(...g);
      if (days) days.forEach((d, i) => found.push({ index: index + i / 10, day: d }));
      else found.push({ index, day: null });          // looked like a date, was not one
      return " ".repeat(m.length);
    });
  };

  // 2026-10-20
  take(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, (y, m, d) => {
    const day = iso(+y, +m, +d);
    return day ? [day] : null;
  });

  // 20-23 oct / 20th to 23rd of october 2026
  take(new RegExp(`\\b(\\d{1,2})${ORD}\\s*(?:-|–|to|till|until)\\s*(\\d{1,2})${ORD}\\s*(?:of\\s+)?${MONTH_RE}\\b(?:,?\\s*(\\d{4}))?`, "g"),
    (d1, d2, mon, y) => rangeIn(today, +d1, +d2, MONTHS[mon.slice(0, 3)], y));

  // oct 20-23 / october 20 to 23, 2026
  take(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})${ORD}\\s*(?:-|–|to|till|until)\\s*(\\d{1,2})${ORD}\\b(?:,?\\s*(\\d{4}))?`, "g"),
    (mon, d1, d2, y) => rangeIn(today, +d1, +d2, MONTHS[mon.slice(0, 3)], y));

  // 20 oct / 20th of october 2026
  take(new RegExp(`\\b(\\d{1,2})${ORD}\\s*(?:of\\s+)?${MONTH_RE}\\b(?:,?\\s*(\\d{4}))?`, "g"),
    (d, mon, y) => one(today, +d, MONTHS[mon.slice(0, 3)], y));

  // oct 20 / october 20th, 2026
  take(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})${ORD}\\b(?:,?\\s*(\\d{4}))?`, "g"),
    (mon, d, y) => one(today, +d, MONTHS[mon.slice(0, 3)], y));

  // "the 20th" / "on the 3rd" — a day with no month: this month if it is
  // still to come, otherwise next month. The ordinal is required, and a
  // following noun ("the 2nd floor", "the 3rd room") rules it out.
  // ("the 20th of October" has already been read by the month patterns.)
  take(/\b(?:on )?the (\d{1,2})(st|nd|rd|th)\b(?! (?:floor|room|guest|person|night|time|one|anniversary|birthday)s?\b)/g, d => {
    const day = Number(d);
    const [y, m] = today.split("-").map(Number);
    const here = iso(y, m, day);
    if (here && here >= today) return [here];
    const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
    const next = iso(ny, nm, day);
    return next ? [next] : null;
  });

  // 20/10, 20/10/2026, 20.10.26 — day first
  take(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/g,
    (d, m, y) => one(today, +d, +m, y));

  return found.sort((a, b) => a.index - b.index);
}

function one(today, d, m, y){
  const day = y ? iso(fullYear(+y), m, d) : nextOccurrence(today, m, d);
  return day ? [day] : null;
}
/* "20-23 Oct": both days in the same month and year as the first. A second
   day before the first ("23-20 Oct") is returned as written and rejected by
   the order check in parseStay. */
function rangeIn(today, d1, d2, m, y){
  const a = one(today, d1, m, y);
  if (!a) return null;
  const b = iso(Number(a[0].slice(0, 4)), m, d2);
  return b ? [a[0], b] : null;
}

/* Relative phrases → a check-in day, plus a default length where the
   phrase implies one ("this weekend" is Friday and Saturday night). */
function relativeStart(s, today){
  if (/\bday after tomorrow\b/.test(s)) return { day: addDays(today, 2) };
  if (/\b(tonight|today|this (?:evening|night)|right now|now|currently|at the moment)\b/.test(s)) return { day: today };
  if (/\btomorrow\b/.test(s)) return { day: addDays(today, 1) };

  const wk = s.match(/\b(next|this|the)?\s*weekend\b/);
  if (wk){
    const dow = weekday(today);
    // Friday of the current week's weekend; on Saturday the weekend is tonight.
    let start = dow === 6 ? today : addDays(today, (5 - dow + 7) % 7);
    if (wk[1] === "next") start = addDays(start, 7);
    return { day: start, nights: dow === 6 && wk[1] !== "next" ? 1 : 2 };
  }

  const wd = s.match(/\b(next|this|on|coming)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wd){
    const target = WEEKDAYS.indexOf(wd[2]);
    let ahead = (target - weekday(today) + 7) % 7;
    if (wd[1] === "next" && ahead === 0) ahead = 7;
    return { day: addDays(today, ahead) };
  }
  return null;
}

function nightsAsked(s){
  const m = s.match(/\b(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+nights?\b/);
  if (m) return WORD_NUM[m[1]] || Number(m[1]);
  const w = s.match(/\b(a|one|two|1|2)\s+weeks?\b/);
  if (w) return 7 * (WORD_NUM[w[1]] || Number(w[1]));
  return null;
}

/**
 * parseStay(text, { now, timeZone, maxNights, maxDaysAhead })
 *
 *   { status: "ok", checkIn, checkOut, nights }
 *   { status: "missing" }                            no date at all
 *   { status: "invalid", reason }                    past | order | too_long | too_far | bad_date
 */
function parseStay(text, opts = {}){
  const timeZone     = opts.timeZone || "Asia/Kolkata";
  const maxNights    = opts.maxNights || 30;
  const maxDaysAhead = opts.maxDaysAhead || 540;
  const today = todayIn(timeZone, opts.now || new Date());
  const s = String(text).toLowerCase();

  const dates = explicitDates(s, today);
  if (dates.some(d => d.day === null)) return { status: "invalid", reason: "bad_date", today };

  const nights = nightsAsked(s);
  let checkIn, checkOut;

  if (dates.length >= 2){
    checkIn = dates[0].day;
    checkOut = dates[1].day;
  } else {
    let start = dates.length ? { day: dates[0].day } : relativeStart(s, today);
    if (!start) return { status: "missing", nights, today };
    checkIn = start.day;
    checkOut = addDays(checkIn, nights || start.nights || 1);
  }

  if (checkIn < today) return { status: "invalid", reason: "past", today };
  if (checkOut <= checkIn) return { status: "invalid", reason: "order", today };
  const n = diffDays(checkIn, checkOut);
  if (n > maxNights) return { status: "invalid", reason: "too_long", today, maxNights };
  if (diffDays(today, checkIn) > maxDaysAhead) return { status: "invalid", reason: "too_far", today };

  return { status: "ok", checkIn, checkOut, nights: n, today };
}

/* "Fri 16 Oct 2026" — fixed English format, built by hand so the output
   does not depend on the server's ICU data. */
const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatDay(day){
  const [y, m, d] = day.split("-").map(Number);
  return `${SHORT_DAYS[weekday(day)]} ${d} ${SHORT_MONTHS[m - 1]} ${y}`;
}

module.exports = { parseStay, todayIn, addDays, diffDays, formatDay, iso, explicitDates, relativeStart, nightsAsked, weekday };
