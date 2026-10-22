"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { extract, normalizePhone, cleanName } = require("../server/booking/extract");

const T = "2026-10-16";            // Friday
const x = (text, step = null) => { const o = extract(text, { today: T, step }); delete o.times; if (!o.dates || !o.dates.length) delete o.dates; return o; };

test("dates, by the question they answer", () => {
  assert.equal(x("October 20, 2026.", "checkIn").checkIn, "2026-10-20");
  assert.equal(x("October 22, 2026", "checkOut").checkOut, "2026-10-22");
  assert.equal(x("22/10", "checkOut").checkOut, "2026-10-22");
  assert.equal(x("tomorrow", "checkIn").checkIn, "2026-10-17");
  assert.equal(x("check out on 25 oct", "party").checkOut, "2026-10-25");
  assert.equal(x("arriving 21 oct", "party").checkIn, "2026-10-21");
  assert.equal(x("25 oct", "party").loneDate, "2026-10-25");
  assert.deepEqual([x("from oct 20 to 22").checkIn, x("from oct 20 to 22").checkOut], ["2026-10-20", "2026-10-22"]);
  assert.equal(x("for 3 nights", "checkOut").nights, 3);
  assert.equal(x("31 feb", "checkIn").badDate, true);
  assert.equal(x("are you full on the 20th?").checkIn, "2026-10-20", "a day with no month: this month");
  assert.equal(x("the 3rd", "checkIn").checkIn, "2026-11-03", "…or next month once it has passed");
  assert.equal(x("check out on the 22nd", "party").checkOut, "2026-10-22");
  assert.deepEqual([x("the 20th to the 23rd").checkIn, x("the 20th to the 23rd").checkOut], ["2026-10-20", "2026-10-23"]);
  assert.equal(x("a room on the 2nd floor").checkIn, undefined);
  const said = x("Could you check if Misty Mountain has availability from the 20th to the 23rd of December, "
    + "and also tell me the price per night and the check-in and check-out times.");
  assert.deepEqual([said.checkIn, said.checkOut], ["2026-12-20", "2026-12-23"], "the month said once, after both days");
});

test("'tonight' in a side question moves nothing", () => {
  assert.deepEqual(x("what is for dinner tonight?", "party"), {});
});

test("times: 12-hour, 24-hour, noon, vague words only when asked", () => {
  assert.equal(x("2 PM", "arrivalTime").arrival, "14:00");
  assert.equal(x("2.30 pm", "arrivalTime").arrival, "14:30");
  assert.equal(x("12 pm", "arrivalTime").arrival, "12:00");
  assert.equal(x("12 am", "arrivalTime").arrival, "00:00");
  assert.equal(x("around 16:45", "arrivalTime").arrival, "16:45");
  assert.equal(x("noon", "arrivalTime").arrival, "12:00");
  assert.equal(x("evening", "arrivalTime").arrival, "18:00");
  assert.equal(x("evening", "party").arrival, undefined);
  assert.equal(x("not sure", "arrivalTime").arrival, "flexible");
  assert.equal(x("we check out at 10am", "party").departure, "10:00");
  assert.equal(x("2.30 pm", "arrivalTime").badDate, undefined, "a time is never read as a date");
});

test("guests and rooms", () => {
  assert.deepEqual(x("4 guests, 2 rooms", "party"), { guests: 4, rooms: 2 });
  assert.deepEqual(x("2 adults and 1 child", "party"), { guests: 3, adults: 2, children: 1 });
  assert.deepEqual(x("for three adults", "party"), { guests: 3, adults: 3 });
  assert.equal(x("a couple", "party").guests, 2);
  assert.equal(x("just me", "party").guests, 1);
  assert.equal(x("family of five", "party").guests, 5);
  assert.equal(x("3", "guests").guests, 3);
  assert.equal(x("2", "rooms").rooms, 2);
  assert.deepEqual(x("5 and 2", "party"), { guests: 5, rooms: 2 });
  assert.equal(x("how many rooms are available?").rooms, undefined, "'how many rooms' is not a count");
  assert.deepEqual(x("2 luxury rooms"), { rooms: 2, roomType: "Luxury" });
});

test("room type", () => {
  assert.equal(x("luxury", "roomType").roomType, "Luxury");
  assert.equal(x("normal", "roomType").roomType, "Normal");
  assert.equal(x("standard room please").roomType, "Normal");
  assert.equal(x("either", "roomType").roomType, "any");
  assert.equal(x("is it normal for it to rain?").roomType, undefined);
  assert.equal(x("got anything free next month?").roomType, undefined, "'anything' is not a room-type answer");
  assert.equal(x("both of us", "party").roomType, undefined);
  assert.equal(x("anything is fine", "roomType").roomType, "any");
  assert.equal(x("2 rooms, either type").roomType, "any");
});

test("room numbers only when choosing rooms", () => {
  assert.deepEqual(x("room 3 and 5", "select").roomNumbers, [3, 5]);
  assert.deepEqual(x("rooms 2, 7 & 9", "select").roomNumbers, [2, 7, 9]);
  assert.equal(x("room 3", "party").roomNumbers, undefined);
});

test("guest details", () => {
  assert.deepEqual(x("Ravi Kumar, 98765 43210, Ravi@Example.com", "guest"), { email: "ravi@example.com", phone: "+919876543210", name: "Ravi Kumar" });
  assert.equal(x("my name is anita desai", "guest").name, "Anita Desai");
  assert.equal(x("is breakfast included?", "guest").name, undefined);
  assert.equal(x("12345", "guest").badPhone, true);
});

test("phone numbers: Indian mobiles normalised, others need a country code", () => {
  assert.equal(normalizePhone("98470 12345"), "+919847012345");
  assert.equal(normalizePhone("098470-12345"), "+919847012345");
  assert.equal(normalizePhone("+91 98470 12345"), "+919847012345");
  assert.equal(normalizePhone("+44 20 7946 0958"), "+442079460958");
  assert.equal(normalizePhone("12345"), null);
  assert.equal(normalizePhone("5551234567"), null, "a 10-digit number not starting 6–9 is not an Indian mobile");
});

test("names", () => {
  assert.equal(cleanName("JOHN O'NEIL"), "John O'Neil");
  assert.equal(cleanName("Priya Sharma"), "Priya Sharma");
  assert.equal(cleanName("R2D2"), null);
  assert.equal(cleanName("what is the price?"), null);
});

test("a name introduced as one is read before the guest step", () => {
  assert.equal(x("2 rooms tomorrow. My name is Asha Nair, phone 98470 12345").name, "Asha Nair");
  assert.equal(x("my name is asha nair and my email is a@b.co").name, "Asha Nair");
  assert.equal(x("book under the name Ravi Menon please").name, "Ravi Menon");
  assert.equal(x("I am looking for a room tomorrow").name, undefined, "no cue, no name");
});
