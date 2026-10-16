"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseStay, todayIn } = require("../server/dates");

// Friday 16 Oct 2026, 11:30 in Kerala.
const NOW = new Date("2026-10-16T06:00:00Z");
const p = (text, extra = {}) => parseStay(text, { now: NOW, timeZone: "Asia/Kolkata", ...extra });
const stay = (text) => { const r = p(text); return r.status === "ok" ? [r.checkIn, r.checkOut] : r.status + ":" + (r.reason || ""); };

test("'today' is the hotel's date, not the server's", () => {
  // 20:00 UTC on the 15th is already 01:30 on the 16th in India.
  assert.equal(todayIn("Asia/Kolkata", new Date("2026-10-15T20:00:00Z")), "2026-10-16");
  assert.equal(todayIn("UTC", new Date("2026-10-15T20:00:00Z")), "2026-10-15");
});

test("relative days", () => {
  assert.deepEqual(stay("any rooms tonight?"), ["2026-10-16", "2026-10-17"]);
  assert.deepEqual(stay("rooms for today"), ["2026-10-16", "2026-10-17"]);
  assert.deepEqual(stay("tomorrow night"), ["2026-10-17", "2026-10-18"]);
  assert.deepEqual(stay("day after tomorrow"), ["2026-10-18", "2026-10-19"]);
  assert.deepEqual(stay("is anything free right now"), ["2026-10-16", "2026-10-17"]);
});

test("weekends and weekdays", () => {
  assert.deepEqual(stay("this weekend"), ["2026-10-16", "2026-10-18"]);   // Fri + Sat nights
  assert.deepEqual(stay("next weekend"), ["2026-10-23", "2026-10-25"]);
  assert.deepEqual(stay("on monday"), ["2026-10-19", "2026-10-20"]);
  assert.deepEqual(stay("this friday"), ["2026-10-16", "2026-10-17"]);
  assert.deepEqual(stay("next friday"), ["2026-10-23", "2026-10-24"]);
});

test("explicit dates, every common spelling", () => {
  assert.deepEqual(stay("2026-10-20"), ["2026-10-20", "2026-10-21"]);
  assert.deepEqual(stay("20 oct"), ["2026-10-20", "2026-10-21"]);
  assert.deepEqual(stay("20th of October"), ["2026-10-20", "2026-10-21"]);
  assert.deepEqual(stay("Oct 20"), ["2026-10-20", "2026-10-21"]);
  assert.deepEqual(stay("october 20th, 2026"), ["2026-10-20", "2026-10-21"]);
  assert.deepEqual(stay("20/10"), ["2026-10-20", "2026-10-21"]);        // day first
  assert.deepEqual(stay("20/10/2026"), ["2026-10-20", "2026-10-21"]);
  assert.deepEqual(stay("20.10.26"), ["2026-10-20", "2026-10-21"]);
});

test("ranges", () => {
  assert.deepEqual(stay("from 20 oct to 23 oct"), ["2026-10-20", "2026-10-23"]);
  assert.deepEqual(stay("20-23 Oct"), ["2026-10-20", "2026-10-23"]);
  assert.deepEqual(stay("oct 20 to 23"), ["2026-10-20", "2026-10-23"]);
  assert.deepEqual(stay("between 30 Oct and 2 Nov"), ["2026-10-30", "2026-11-02"]);
  assert.deepEqual(stay("2026-12-30 to 2027-01-02"), ["2026-12-30", "2027-01-02"]);
});

test("length of stay", () => {
  assert.deepEqual(stay("tonight for 3 nights"), ["2026-10-16", "2026-10-19"]);
  assert.deepEqual(stay("from 20 oct for two nights"), ["2026-10-20", "2026-10-22"]);
  assert.deepEqual(stay("a week from tomorrow"), ["2026-10-17", "2026-10-24"]);
});

test("a date with no year that has passed means next year", () => {
  assert.deepEqual(stay("3 march"), ["2027-03-03", "2027-03-04"]);
  assert.deepEqual(stay("16 oct"), ["2026-10-16", "2026-10-17"]);   // today still counts
});

test("missing dates are reported, not guessed", () => {
  assert.equal(p("do you have rooms available?").status, "missing");
  assert.equal(p("rooms for 2 adults").status, "missing");
});

test("invalid dates are reported with a reason", () => {
  assert.equal(stay("15 oct 2026"), "invalid:past");
  assert.equal(stay("31/02/2027"), "invalid:bad_date");
  assert.equal(stay("23-20 oct"), "invalid:order");
  assert.equal(stay("from 20 oct to 15 dec"), "invalid:too_long");
  assert.equal(stay("1 jan 2030"), "invalid:too_far");
});
