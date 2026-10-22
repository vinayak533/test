/* ============================================================================
   server/booking/extract.js — booking details out of a guest's own words.

   Deterministic rules, no model: "2 PM" means 14:00 every time and a test can
   pin it down. Each extractor returns only what it actually found; the flow
   decides what to do with it, and validates it, using the step it had asked
   about as context ("3" answers "how many guests?" but not "which date?").

   extract(text, { today, step }) →
     { checkIn?, checkOut?, nights?, dates: [...], badDate?,
       arrival?, departure?, times: [...],
       guests?, rooms?, roomType?, roomNumbers?: [...],
       email?, phone?, badPhone?, name? }
   ============================================================================ */

"use strict";

const { explicitDates, relativeStart, nightsAsked, addDays } = require("../dates");

const WORD_NUM = { a: 1, an: 1, one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
                   seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const NUM = "(\\d{1,2}|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
const toNum = w => WORD_NUM[w] || Number(w);

/* ---- times ---------------------------------------------------------------- */

const pad = n => String(n).padStart(2, "0");

/* Every clock time in the text, in reading order, each blanked out of the
   returned string so the date reader cannot mistake "2.30 pm" for 2 March. */
function readTimes(s){
  const times = [];
  let work = s;
  const take = (re, build) => {
    work = work.replace(re, (m, ...g) => {
      const index = g[g.length - 2];
      const t = build(...g);
      if (t) times.push({ index, time: t });
      return " ".repeat(m.length);
    });
  };
  // 2 pm, 2:30pm, 2.30 p.m., 12 noon
  take(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/g, (h, m, ap) => {
    let hh = Number(h); const mm = m ? Number(m) : 0;
    if (hh < 1 || hh > 12 || mm > 59) return null;
    const pm = ap[0] === "p";
    if (hh === 12) hh = pm ? 12 : 0; else if (pm) hh += 12;
    return pad(hh) + ":" + pad(mm);
  });
  // 14:00, 9:30 (24-hour, a colon required so "20 oct" is never a time)
  take(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (h, m) => pad(Number(h)) + ":" + m);
  take(/\b(12\s*)?(noon|midday)\b/g, () => "12:00");
  take(/\bmidnight\b/g, () => "00:00");
  return { times: times.sort((a, b) => a.index - b.index), rest: work };
}

/* Words that stand for a time only when a time is what was asked. */
const VAGUE_TIMES = [
  [/\b(early )?morning\b/, "10:00"], [/\b(late )?afternoon\b/, "15:00"],
  [/\bevening\b/, "18:00"], [/\b(late )?night\b/, "21:00"]
];
const FLEXIBLE = /\b(not sure|don'?t know|no idea|flexible|any ?time|undecided|not decided|later|tbd)\b/;

const ARRIVAL_CUE   = /\b(arriv\w*|reach\w*|get(?:ting)? there|check(?:ing)?[\s-]?in|come in|eta)\b/;
const DEPARTURE_CUE = /\b(check(?:ing)?[\s-]?out|leav\w*|depart\w*)\b/;

/* ---- people and rooms ----------------------------------------------------- */

function readGuests(s){
  let total = 0, found = false;
  const adults = s.match(new RegExp(`\\b${NUM}\\s+(?:adults?|grown[\\s-]?ups?)\\b`));
  const kids   = s.match(new RegExp(`\\b${NUM}\\s+(?:kids?|child(?:ren)?|infants?|bab(?:y|ies)|toddlers?)\\b`));
  if (adults){ total += toNum(adults[1]); found = true; }
  if (kids){ total += toNum(kids[1]); found = true; }
  if (found) return total;

  const plain = s.match(new RegExp(`\\b${NUM}\\s+(?:guests?|people|persons?|pax|travell?ers|members|of us|ppl)\\b`));
  if (plain) return toNum(plain[1]);
  const family = s.match(/\b(?:family|group|party) of (\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\b/);
  if (family) return toNum(family[1]);
  const weAre = s.match(/\b(?:we are|we're|there are|there will be|there'll be)\s+(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\b/);
  if (weAre) return toNum(weAre[1]);
  if (/\b(a couple|my (?:wife|husband|partner)|the two of us|both of us)\b/.test(s)) return 2;
  if (/\b(just me|only me|myself|solo|alone|by myself|one person)\b/.test(s)) return 1;
  return null;
}

function readRooms(s){
  const m = s.match(new RegExp(`\\b${NUM}\\s+(?:(?:normal|luxury|luxurious|standard|regular|deluxe|premium)\\s+)?rooms?\\b`));
  return m ? toNum(m[1]) : null;
}

/* "room 3", "rooms 3 and 5", "#7" — specific rooms from the list we showed.
   Spoken, the number may come back as a word: "room seven". */
const ROOM_NO = "(?:\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
const ROOM_NOS_RE = new RegExp(`\\b(?:rooms?|no\\.?|number|#)\\s*#?\\s*(${ROOM_NO}(?:\\s*(?:,|and|&|\\+)\\s*#?\\s*${ROOM_NO})*)\\b`);
function readRoomNumbers(s){
  const m = s.match(ROOM_NOS_RE);
  if (!m) return null;
  return [...new Set(m[1].match(new RegExp(`\\b${ROOM_NO}\\b`, "g")).map(toNum))];
}

function readRoomType(s, step){
  if (/\b(luxur(?:y|ious)|premium|deluxe|upgraded?)\b/.test(s)) return "Luxury";
  if (/\b(normal|standard|regular|basic|economy|budget|cheap(?:er|est)?)\s+(?:rooms?|ones?|type)\b/.test(s)) return "Normal";
  // Only phrases that are about the room type count anywhere; "anything" or
  // "both" in "got anything free?" or "both of us" are not a preference.
  if (/\b(either (?:type|kind|one|room|is fine)|any (?:room )?(?:type|kind)|no (?:room )?preference|either room type)\b/.test(s)) return "any";
  if (step === "roomType"){
    if (/\b(normal|standard|regular|basic|economy|budget|cheap(?:er|est)?)\b/.test(s)) return "Normal";
    if (/\b(either|any|both|anything|whichever|doesn'?t matter|don'?t mind|no preference)\b/.test(s)) return "any";
  }
  return null;
}

/* ---- contact details ------------------------------------------------------ */

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i;

/* An address as speech-to-text writes it: "asha at example dot com",
   "asha.nair at the rate gmail.com". Read only where an address is what
   was asked for, so "arriving at 2" is never taken for one. */
const SPOKEN_EMAIL_RE = /\b([a-z0-9][a-z0-9._-]*)\s+(?:at the rate(?: of)?|at)\s+([a-z0-9-]+(?:\s*(?:\.|\bdot\b)\s*[a-z0-9-]+)+)\b/i;
function spokenEmail(s){
  const m = s.match(SPOKEN_EMAIL_RE);
  if (!m) return null;
  const email = (m[1] + "@" + m[2].replace(/\s*(?:\bdot\b|\.)\s*/gi, ".")).toLowerCase();
  const ok = email.match(EMAIL_RE);
  return ok && ok[0] === email ? { index: m.index, length: m[0].length, email } : null;
}

/* India first: a bare 10-digit mobile starting 6–9 becomes +91. Anything
   with an explicit + keeps its own country code. */
function normalizePhone(raw){
  if (typeof raw !== "string") return null;
  const plus = raw.trim().startsWith("+");
  let d = raw.replace(/\D/g, "");
  if (plus) return d.length >= 8 && d.length <= 15 ? "+" + d : null;
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 10 && /^[6-9]/.test(d)) return "+91" + d;
  return null;
}

function readPhone(s){
  const m = s.match(/(\+?\d[\d\s\-().]{3,18}\d)/);
  if (!m) return null;
  const digits = m[1].replace(/\D/g, "");
  if (digits.length < 5) return null;
  return { raw: m[1], phone: normalizePhone(m[1]) };
}

const NAME_OK = /^[\p{L}][\p{L}\p{M}'’. -]{1,79}$/u;
const QUESTION_START = /^(what|how|is|are|do|does|can|could|where|when|why|which|will|would|should|may|tell|show|any)\b/i;

function cleanName(raw){
  let s = String(raw || "").replace(/\s+/g, " ").trim();
  s = s.replace(/^(?:hi|hello|hey)[,!. ]+/i, "")
       .replace(/^(?:my name is|my name's|name is|name:|i am|i'm|this is|it's|it is|guest name is|guest:|the guest is)\s*/i, "")
       .replace(/[,.;:!]+$/g, "").trim();
  if (!s || s.includes("?") || QUESTION_START.test(s) || /\d/.test(s)) return null;
  if (s.split(" ").length > 6 || !NAME_OK.test(s)) return null;
  // Title-case only names typed entirely in one case.
  if (s === s.toLowerCase() || s === s.toUpperCase()){
    s = s.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  }
  return s;
}

/* ---- dates ---------------------------------------------------------------- */

const CHECKOUT_DATE_CUE = /\b(check(?:ing)?[\s-]?out|leav\w*|depart\w*|until|till|returning)\b/;
const CHECKIN_DATE_CUE  = /\b(check(?:ing)?[\s-]?in|arriv\w*|from|starting|coming on)\b/;

/* ---- entry point ---------------------------------------------------------- */

function extract(text, { today, step = null } = {}){
  const original = String(text || "");
  const lower = original.toLowerCase();
  const out = {};

  // Contact details first, and out of the way of everything else: an email
  // address or phone number is full of digits the date reader would misread.
  let s = lower;
  let said = original;                    // the text the name is read from
  const email = original.match(EMAIL_RE);
  if (email){ out.email = email[0].toLowerCase(); s = s.replace(email[0].toLowerCase(), " "); }
  else if (step === "guest" || /\be-?mail\b/.test(lower)){
    const spoken = spokenEmail(lower);
    if (spoken){
      out.email = spoken.email;
      const blank = t => t.slice(0, spoken.index) + " ".repeat(spoken.length) + t.slice(spoken.index + spoken.length);
      s = blank(s);
      if (said.length === lower.length) said = blank(said);
    }
  }
  if (step === "guest" || /\b(phone|mobile|number|contact|whatsapp|call me)\b/.test(s)){
    const ph = readPhone(s);
    if (ph){ if (ph.phone) out.phone = ph.phone; else out.badPhone = true; s = s.replace(ph.raw, " "); }
  }
  if (step === "guest"){
    const rest = said.replace(email ? email[0] : "", " ")
      .replace(/(\+?\d[\d\s\-().]{6,18}\d)/, " ")
      .replace(/\b(?:phone|mobile|email|e-mail|number|contact)\s*(?:is|:)?/gi, " ")
      .split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
    for (const part of rest){
      const n = cleanName(part);
      if (n){ out.name = n; break; }
    }
  }

  // Times, then dates from what is left.
  const { times, rest } = readTimes(s);
  s = rest;
  out.times = times.map(t => t.time);

  if (times.length){
    for (const t of times){
      const before = lower.slice(Math.max(0, t.index - 40), t.index);
      if (DEPARTURE_CUE.test(before)) out.departure = out.departure || t.time;
      else if (ARRIVAL_CUE.test(before)) out.arrival = out.arrival || t.time;
    }
    const unassigned = times.find(t => t.time !== out.arrival && t.time !== out.departure);
    if (unassigned){
      if (step === "departure") out.departure = out.departure || unassigned.time;
      else if (step === "arrivalTime" || (!out.arrival && step !== "departure")) out.arrival = out.arrival || unassigned.time;
    }
  } else if (step === "arrivalTime"){
    if (FLEXIBLE.test(s)) out.arrival = "flexible";
    else for (const [re, t] of VAGUE_TIMES) if (re.test(s)){ out.arrival = t; break; }
  }

  if (today){
    const found = explicitDates(s, today);
    if (found.some(d => d.day === null)) out.badDate = true;
    const dates = found.filter(d => d.day).map(d => d.day);
    out.dates = dates;
    const nights = nightsAsked(s);
    if (nights) out.nights = nights;

    if (dates.length >= 2){
      out.checkIn = dates[0];
      out.checkOut = dates[1];
    } else if (dates.length === 1){
      const at = s.search(/\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/);
      const before = s.slice(0, at > 0 ? at : 0);
      if (CHECKOUT_DATE_CUE.test(before)) out.checkOut = dates[0];
      else if (CHECKIN_DATE_CUE.test(before)) out.checkIn = dates[0];
      else if (step === "checkOut") out.checkOut = dates[0];
      else if (step === "checkIn" || !step) out.checkIn = dates[0];
      else out.loneDate = dates[0];
    } else {
      // "tomorrow", "this weekend", "next friday" — read only when a date is
      // what is being talked about, so "tonight" in a question about dinner
      // halfway through a booking moves nothing.
      const rel = relativeStart(s, today);
      const aboutDates = !step || step === "checkIn" || step === "checkOut"
        || /\b(check\w*|arriv\w*|stay\w*|book\w*|rooms?|nights?|from|until|till)\b/.test(s);
      if (rel && aboutDates){
        if (CHECKOUT_DATE_CUE.test(s) || (step === "checkOut" && !CHECKIN_DATE_CUE.test(s))) out.checkOut = rel.day;
        else {
          out.checkIn = rel.day;
          if (rel.nights && !nights) out.checkOut = addDays(rel.day, rel.nights);
        }
      }
    }
  }

  const rooms = readRooms(s);
  if (rooms) out.rooms = rooms;
  const guests = readGuests(s);
  if (guests) out.guests = guests;

  // A bare number answers the question that was just asked.
  const bare = s.match(/^\s*(?:just\s+|only\s+)?(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:please|pls)?[.!]?\s*$/);
  if (bare){
    if (step === "guests" || (step === "party" && !out.guests)) out.guests = toNum(bare[1]);
    else if (step === "rooms") out.rooms = toNum(bare[1]);
  }
  // "4 guests, 2" / "4 and 2" when both were asked for at once: guests
  // first, rooms second, as the question asked them.
  if (step === "party" && !out.rooms){
    const pair = s.match(/^\s*(\d{1,2})\D+(\d{1,2})\s*$/);
    if (pair && (!out.guests || Number(pair[1]) === out.guests)){
      out.guests = Number(pair[1]);
      out.rooms = Number(pair[2]);
    }
  }

  const type = readRoomType(s, step);
  if (type) out.roomType = type;

  if (step === "select"){
    const nums = readRoomNumbers(s);
    if (nums) out.roomNumbers = nums;
  }
  return out;
}

module.exports = { extract, readTimes, normalizePhone, cleanName, EMAIL_RE };
