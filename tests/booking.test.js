"use strict";

/* The booking conversation, end to end through server/chat.js, against an
   in-memory repository (tests/helpers.js). Today is Fri 16 Oct 2026. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { conversation, fakeRepo, optionLabels, option, uuid, CONFIG } = require("./helpers");

const confirmed = (room, check_in, check_out, extra = {}) =>
  ({ ref: "MM-OLD" + room, room_id: uuid(room), check_in, check_out, status: "confirmed", num_guests: 2, price: 2500, total_price: 5000, ...extra });

/* ---- the conversation from the brief, word for word ------------------------- */

test("the example conversation: asks one thing at a time, in order", async () => {
  const c = conversation();
  let out = await c.say("How many rooms are available?");
  assert.equal(out.reply, "I'd be happy to check room availability at Misty Mountain. What date would you like to check in?");
  assert.ok(out.ui.date, "offers a date picker");
  assert.ok(optionLabels(out).some(l => /^Today/.test(l)), "offers tappable dates");

  out = await c.say("October 20, 2026.");
  assert.match(out.reply, /^Great! What time do you expect to arrive\?/);
  assert.ok(optionLabels(out).includes("2:00 PM (check-in)"));

  out = await c.say("2 PM");
  assert.equal(out.reply, "And what date would you like to check out?");

  out = await c.say("October 22, 2026");
  assert.match(out.reply, /Check-out is by 12:00 PM on Thu 22 Oct, as per hotel policy\./);
  assert.match(out.reply, /How many guests will be staying, and how many rooms do you need\?$/);

  out = await c.say("3 guests, 1 room");
  assert.match(out.reply, /Which room type would you prefer — Normal \(₹2,500 per night\) or Luxury \(₹4,500 per night\)\?/);
  assert.deepEqual(optionLabels(out).slice(0, 3), ["Normal · ₹2,500/night", "Luxury · ₹4,500/night", "Either is fine"]);

  out = await c.say("luxury");
  assert.equal(out.kind, "answer");
  assert.match(out.reply, /4 Luxury rooms are available .* Luxury rooms 7, 8, 9 and 10 at ₹4,500 per night/);
  assert.equal(out.ui.panel.type, "rooms");
  assert.deepEqual(out.ui.panel.available.map(r => r.number), [7, 8, 9, 10]);
  assert.equal(out.ui.panel.nights, 2);
  assert.equal(out.ui.panel.available[0].stayTotal, 9000);

  // Nothing has been written by any of that.
  assert.ok(!c.repo.calls.some(([k]) => k === "hold" || k === "confirm"));
  assert.equal(c.repo.res.length, 0);
});

test("ask only for what is missing: one rich message skips straight ahead", async () => {
  const c = conversation();
  const out = await c.say("I want to book 2 luxury rooms from Oct 20 to 22 for 4 guests, arriving at 2pm");
  assert.equal(out.ui.panel.type, "rooms", "goes straight to live availability");
  assert.match(out.reply, /Got it — check-in Tue 20 Oct, arriving around 2:00 PM, check-out Thu 22 Oct, 4 guests and 2 Luxury rooms/);
  const st = c.decoded();
  assert.deepEqual([st.checkIn, st.checkOut, st.arrival, st.guests, st.rooms, st.roomType], ["2026-10-20", "2026-10-22", "14:00", 4, 2, "Luxury"]);
});

test("taps and typing are interchangeable and remembered", async () => {
  const c = conversation();
  await c.say("any rooms?");
  let out = await c.tap({ type: "set", slot: "checkIn", value: "2026-10-23" });
  assert.match(out.reply, /What time do you expect to arrive/);
  out = await c.say("not sure yet");
  assert.match(out.reply, /check-in is from 2:00 PM whenever you arrive/);
  out = await c.tap({ type: "set", slot: "checkOut", value: "2026-10-25" });
  out = await c.tap({ type: "set", slot: "party", value: { guests: 2, rooms: 1 } });
  out = await c.tap({ type: "set", slot: "roomType", value: "any" });
  assert.equal(out.ui.panel.type, "rooms");
  assert.equal(out.ui.panel.available.length, 10);
  assert.equal(c.decoded().arrival, "flexible");
});

/* ---- validation --------------------------------------------------------------- */

test("a past check-in date is refused", async () => {
  const c = conversation();
  await c.say("any rooms available?");
  const out = await c.tap({ type: "set", slot: "checkIn", value: "2026-10-10" });
  assert.match(out.reply, /That date has already passed — today is Fri 16 Oct 2026/);
  assert.equal(c.decoded().checkIn, undefined);
});

test("check-out must be after check-in", async () => {
  const c = conversation();
  await c.say("rooms from 20 oct?");
  await c.say("3pm");
  let out = await c.say("check out on 19 oct");
  assert.match(out.reply, /Check-out needs to be after your check-in date \(Tue 20 Oct\)/);
  out = await c.tap({ type: "set", slot: "checkOut", value: "2026-10-20" });
  assert.match(out.reply, /Check-out needs to be after/);
  assert.equal(c.decoded().checkOut, undefined);
});

test("stays longer than policy are refused", async () => {
  const c = conversation();
  await c.say("book a room from 20 oct");
  await c.say("2pm");
  const out = await c.tap({ type: "set", slot: "checkOut", value: "2026-12-20" });
  assert.match(out.reply, /up to 30 nights/);
});

test("arrival earlier today than now is refused; early arrival gets the policy note", async () => {
  const c = conversation();
  await c.say("any rooms tonight?");                     // 11:30 at the hotel
  let out = await c.say("10 am");
  assert.match(out.reply, /already past 10:00 AM at the hotel today/);
  out = await c.say("1 pm");
  assert.match(out.reply, /Check-in begins at 2:00 PM.*can't be guaranteed/);
});

test("a late check-out time is held to policy", async () => {
  const c = conversation();
  await c.say("rooms 20 to 22 oct");
  await c.say("2pm");
  const out = await c.say("we will check out at 3 pm");
  assert.match(out.reply, /Check-out is by 12:00 PM under hotel policy/);
  assert.equal(c.decoded().departure, "12:00");
});

test("occupancy: guests per room are limited by configured capacity", async () => {
  const c = conversation();
  await c.say("rooms 20 to 22 oct, arriving 2pm");
  let out = await c.say("7 guests, 2 rooms");
  assert.match(out.reply, /sleeps up to 3 guests, so 7 guests will need at least 3 rooms/);
  assert.equal(c.decoded().guests, 7);
  assert.equal(c.decoded().rooms, undefined);
  assert.deepEqual(optionLabels(out).slice(0, 3), ["3 rooms", "4 rooms", "5 rooms"]);
  out = await c.say("2 guests 3 rooms");
  assert.match(out.reply, /at least one guest/);
  out = await c.say("31 guests");
  assert.match(out.reply, /up to 30 guests across our 10 rooms/);
});

test("room type inventory: more Luxury rooms than exist is refused", async () => {
  const c = conversation();
  await c.say("rooms 20 to 22 oct, arriving 2pm, 10 guests 5 rooms");
  const out = await c.say("luxury");
  assert.match(out.reply, /We have 4 Luxury rooms in total/);
  assert.equal(c.decoded().roomType, undefined);
});

/* ---- real availability ---------------------------------------------------------- */

test("overlapping bookings are excluded; same-day turnover is allowed", async () => {
  const repo = fakeRepo({ reservations: [
    confirmed(7, "2026-10-18", "2026-10-20"),             // leaves the morning we arrive: free
    confirmed(8, "2026-10-21", "2026-10-25"),             // overlaps the 21st: taken
    confirmed(9, "2026-10-19", "2026-10-21", { status: "cancelled" }),   // cancelled: free
    confirmed(10, "2026-10-20", "2026-10-22", { status: "checked_out" }) // checked out early: free
  ] });
  const c = conversation({ repo });
  const out = await c.say("2 luxury rooms from 20 oct to 22 oct for 2 guests arriving 2pm");
  assert.deepEqual(out.ui.panel.available.map(r => r.number), [7, 9, 10]);
  assert.match(out.reply, /3 Luxury rooms are available/);
  assert.deepEqual(repo.calls.find(c => c[0] === "availability"), ["availability", "2026-10-20", "2026-10-22", "misty_mountain"]);
});

test("not enough of the requested type: says what there is and offers alternatives", async () => {
  const repo = fakeRepo({ reservations: [7, 8, 9].map(n => confirmed(n, "2026-10-19", "2026-10-23")) });
  const c = conversation({ repo });
  const out = await c.say("2 luxury rooms 20 oct to 22 oct, 4 guests, arriving 2pm");
  assert.match(out.reply, /only 1 Luxury room is free .* and you asked for 2/);
  assert.ok(optionLabels(out).includes("See Normal rooms (6 free)"));
  assert.ok(optionLabels(out).includes("Either type"));
  assert.equal(out.ui.panel.type, "unavailable");
});

test("fully booked: says so, offers other dates", async () => {
  const repo = fakeRepo({ reservations: Array.from({ length: 10 }, (_, i) => confirmed(i + 1, "2026-10-01", "2026-11-01")) });
  const c = conversation({ repo });
  const out = await c.say("a room 20 oct to 22 oct for 2 guests, arriving 2pm, either type");
  assert.match(out.reply, /fully booked for Tue 20 Oct 2026 to Thu 22 Oct 2026/);
  assert.ok(optionLabels(out).includes("Change dates"));
});

/* ---- booking -------------------------------------------------------------------- */

async function toRooms(c, msg = "1 normal room from 20 oct to 22 oct for 2 guests arriving 2pm"){
  const out = await c.say(msg);
  assert.equal(out.ui.panel.type, "rooms");
  return out;
}

test("full booking: hold → guest details → summary → explicit confirm → reference", async () => {
  const c = conversation();
  let out = await toRooms(c);
  const pick = out.ui.panel.selected;
  assert.deepEqual(pick, [uuid(1)], "cheapest room preselected");

  out = await c.tap({ type: "book", roomIds: [uuid(3)] });
  assert.match(out.reply, /Room 3 \(Normal\) is held for you until .* 2 nights, ₹5,000 in total\. It isn't booked until you confirm\./);
  assert.equal(out.ui.form.type, "guest");
  assert.equal(c.repo.res[0].status, "held");
  assert.ok(!c.repo.calls.some(([k]) => k === "confirm"), "a hold is not a booking");

  out = await c.tap({ type: "guest", name: "asha nair", phone: "98470 12345", email: "Asha@Example.com" });
  assert.match(out.reply, /Here's your booking summary/);
  assert.equal(out.ui.panel.stage, "review");
  assert.deepEqual(out.ui.panel.guest, { name: "Asha Nair", phone: "+919847012345", email: "asha@example.com" });
  assert.equal(out.ui.panel.total, 5000);
  assert.ok(!c.repo.calls.some(([k]) => k === "confirm"), "the summary is not a booking either");

  out = await c.tap({ type: "confirm" });
  assert.match(out.reply, /^Your booking is confirmed! Your booking reference is MM-TESTA\./);
  assert.equal(out.ui.panel.stage, "confirmed");
  assert.equal(c.repo.res[0].status, "confirmed");
  assert.equal(c.decoded().flow, null);

  // A second tap cannot book twice.
  out = await c.tap({ type: "confirm" });
  assert.match(out.reply, /already confirmed/);
  assert.equal(c.repo.calls.filter(([k]) => k === "confirm").length, 1);
});

test("totals come from nights × each room's rate, across room types", async () => {
  const c = conversation();
  await toRooms(c, "2 rooms, either type, from 20 oct to 23 oct, 4 guests, arriving 4pm");
  const out = await c.tap({ type: "book", roomIds: [uuid(2), uuid(9)] });
  const hold = c.decoded().hold;
  assert.equal(hold.nights, 3);
  assert.deepEqual(hold.rooms.map(r => [r.number, r.price, r.total]), [[2, 2500, 7500], [9, 4500, 13500]]);
  assert.equal(hold.total, 21000);
  assert.match(out.reply, /₹21,000 in total/);
  assert.deepEqual(hold.rooms.map(r => r.guests).reduce((a, b) => a + b), 4, "every guest placed");
});

test("typed room numbers and 'confirm' work too", async () => {
  const c = conversation();
  await toRooms(c);
  let out = await c.say("room 5");
  assert.match(out.reply, /Room 5 \(Normal\) is held/);
  out = await c.say("Ravi Kumar, 98765 43210, ravi@example.com");
  assert.equal(out.ui.panel.stage, "review");
  out = await c.say("yes, confirm");
  assert.match(out.reply, /booking is confirmed/);
});

test("the wrong number of rooms, or a room not free, is refused before any hold", async () => {
  const repo = fakeRepo({ reservations: [confirmed(4, "2026-10-21", "2026-10-22")] });
  const c = conversation({ repo });
  await toRooms(c, "2 normal rooms from 20 oct to 22 oct for 3 guests arriving 2pm");
  let out = await c.tap({ type: "book", roomIds: [uuid(1)] });
  assert.match(out.reply, /please choose exactly 2/);
  out = await c.say("rooms 1 and 4");
  assert.match(out.reply, /room 4 is no longer available/);
  assert.ok(!repo.calls.some(([k]) => k === "hold"));
});

test("a room taken between showing and booking: explains and shows updated availability", async () => {
  const c = conversation();
  await toRooms(c);
  // Someone else books room 1 for overlapping nights in the meantime.
  c.repo.res.push(confirmed(1, "2026-10-21", "2026-10-24"));
  const out = await c.tap({ type: "book", roomIds: [uuid(1)] });
  assert.match(out.reply, /room 1 is no longer available for your dates/);
  assert.equal(out.ui.panel.type, "rooms");
  assert.ok(!out.ui.panel.available.some(r => r.number === 1));
});

test("the database refuses the hold (race lost): explains and shows updated availability", async () => {
  const repo = fakeRepo({ holdResult: { ok: false, reason: "unavailable", rooms: [2] } });
  const c = conversation({ repo });
  await toRooms(c);
  const out = await c.tap({ type: "book", roomIds: [uuid(2)] });
  assert.match(out.reply, /room 2 was just booked by another guest\. Here's the updated availability/);
  assert.equal(out.ui.panel.type, "rooms");
  assert.equal(c.decoded().hold, undefined);
});

test("the room goes before confirmation: nothing is saved, updated availability offered", async () => {
  const repo = fakeRepo({ confirmResult: { ok: false, reason: "unavailable", rooms: [3] } });
  const c = conversation({ repo });
  await toRooms(c);
  await c.tap({ type: "book", roomIds: [uuid(3)] });
  await c.tap({ type: "guest", name: "Asha Nair", phone: "9847012345", email: "asha@example.com" });
  const out = await c.tap({ type: "confirm" });
  assert.match(out.reply, /room 3 was booked by another guest before you confirmed.*Nothing has been saved or charged/);
  assert.equal(out.ui.panel.type, "rooms");
  assert.equal(c.decoded().hold, undefined);
  assert.equal(c.decoded().guest.name, "Asha Nair", "guest details kept for the retry");
});

test("confirm is refused until the summary has been shown", async () => {
  const c = conversation();
  await toRooms(c);
  await c.tap({ type: "book", roomIds: [uuid(1)] });
  const out = await c.tap({ type: "confirm" });
  assert.doesNotMatch(out.reply, /confirmed!/);
  assert.ok(!c.repo.calls.some(([k]) => k === "confirm"));
});

test("invalid guest details are rejected field by field", async () => {
  const c = conversation();
  await toRooms(c);
  await c.tap({ type: "book", roomIds: [uuid(1)] });
  const out = await c.tap({ type: "guest", name: "A1", phone: "12345", email: "not-an-email" });
  assert.equal(out.ui.form.errors.length, 3);
  assert.equal(c.decoded().guest.name, undefined);
});

test("changing the dates after a hold releases it", async () => {
  const c = conversation();
  await toRooms(c);
  await c.tap({ type: "book", roomIds: [uuid(1)] });
  const out = await c.say("actually check in on 21 oct");
  assert.ok(c.repo.calls.some(([k]) => k === "release"));
  assert.equal(c.decoded().hold, undefined);
  assert.match(out.reply, /cleared your check-out date|available/);
});

test("start over and cancel release the hold", async () => {
  const c = conversation();
  await toRooms(c);
  await c.tap({ type: "book", roomIds: [uuid(1)] });
  let out = await c.say("start over");
  assert.match(out.reply, /Let's start again\. What date would you like to check in\?/);
  assert.equal(c.repo.res[0].status, "expired");
  await toRooms(c);
  await c.tap({ type: "book", roomIds: [uuid(2)] });
  out = await c.tap({ type: "cancel" });
  assert.match(out.reply, /Nothing was booked/);
  assert.equal(c.state, null);
});

/* ---- failures never invent anything ----------------------------------------------- */

for (const fail of ["availability", "rooms"]){
  test(`database down (${fail}): no availability is invented`, async () => {
    const c = conversation({ repo: fakeRepo({ fail }) });
    const out = await c.say("2 normal rooms from 20 oct to 22 oct for 3 guests arriving 2pm");
    assert.equal(out.kind, "error");
    assert.match(out.reply, /couldn't reach our reservations system/);
    assert.doesNotMatch(out.reply, /\d+ (Normal |Luxury )?rooms? (is|are) available/);
    assert.equal(out.desk, true);
  });
}

test("database down at confirm: never claims success, retry is offered", async () => {
  const repo = fakeRepo();
  const c = conversation({ repo });
  await toRooms(c);
  await c.tap({ type: "book", roomIds: [uuid(1)] });
  await c.tap({ type: "guest", name: "Asha Nair", phone: "9847012345", email: "asha@example.com" });
  repo.confirmBooking = async () => { throw new Error("socket hang up"); };
  const out = await c.tap({ type: "confirm" });
  assert.equal(out.kind, "error");
  assert.match(out.reply, /can't tell whether your booking went through/);
  assert.doesNotMatch(out.reply, /is confirmed/);
  assert.deepEqual(optionLabels(out)[0], "Try again");
  assert.ok(c.decoded().hold, "the hold is kept so the retry can complete it");
});

test("hotels table down mid-booking: an error, not a hand-off to the page", async () => {
  const repo = fakeRepo();
  const c = conversation({ repo });
  await c.say("any rooms?");
  repo.listHotels = async () => { throw new Error("down"); };
  const out = await c.say("20 oct");
  assert.equal(out.handled, true);
  assert.equal(out.kind, "error");
});

/* ---- side questions, state, hostile input ------------------------------------------ */

test("a side question mid-booking goes to the knowledge base and the booking waits", async () => {
  const c = conversation();
  await c.say("rooms from 20 oct to 22 oct");
  const before = c.state;
  const out = await c.say("is breakfast included?");
  assert.equal(out.handled, false);
  assert.equal(out.bookingActive, true);
  assert.equal(c.state, before, "state untouched");
  const back = await c.tap({ type: "resume" });
  assert.match(back.reply, /What time do you expect to arrive/);
});

test("a tampered state token is ignored, not trusted", async () => {
  const c = conversation();
  await toRooms(c);
  await c.tap({ type: "book", roomIds: [uuid(1)] });
  const [body, mac] = c.state.split(".");
  const st = JSON.parse(Buffer.from(body, "base64url"));
  st.hold.total = 1;
  c.state = Buffer.from(JSON.stringify(st)).toString("base64url") + "." + mac;
  const out = await c.tap({ type: "confirm" });
  assert.doesNotMatch(out.reply, /confirmed/);
  assert.ok(!c.repo.calls.some(([k]) => k === "confirm"));
});

test("malformed actions are rejected outright", async () => {
  const { InputError } = require("../server/sanitize");
  const c = conversation();
  for (const bad of [
    { type: "drop_tables" }, { type: "set", slot: "price", value: 1 }, { type: "set", slot: "checkIn", value: "tomorrow" },
    { type: "book", roomIds: ["1; delete"] }, { type: "set", slot: "party", value: { guests: "2", rooms: 1 } }, "confirm"
  ]){
    await assert.rejects(c.tap(bad), InputError, JSON.stringify(bad));
  }
});

/* ---- one spoken sentence, every detail kept -------------------------------- */

test("'book a luxury room from today for two days for three adults' asks only the arrival time", async () => {
  const c = conversation();
  const out = await c.say("Book a luxury room from today for two days for three adults.");
  assert.match(out.reply, /Got it — check-in Fri 16 Oct, check-out Sun 18 Oct, 3 adults and 1 Luxury room\./);
  assert.match(out.reply, /What time do you expect to arrive\?/);
  const st = c.decoded();
  assert.deepEqual([st.checkIn, st.checkOut, st.guests, st.adults, st.rooms, st.roomType], ["2026-10-16", "2026-10-18", 3, 3, 1, "Luxury"]);

  const next = await c.say("3 pm");
  assert.equal(next.ui.panel.type, "rooms", "straight on to live availability");
  assert.equal(next.ui.panel.nights, 2);
  assert.equal(next.ui.panel.party, "3 adults");
  assert.ok(next.ui.panel.available.every(r => r.type === "Luxury"));
  assert.ok(!c.repo.calls.some(([k]) => k === "hold" || k === "confirm"), "nothing held or booked");
});

test("adults and children are kept apart, and a correction keeps the other half", async () => {
  const c = conversation();
  let out = await c.say("a normal room tomorrow for 2 nights for 1 adult and 1 child");
  assert.match(out.reply, /1 adult and 1 child and 1 Normal room/);
  out = await c.say("actually make it 2 adults");
  assert.match(out.reply, /Got it — 2 adults and 1 child\./);
  const st = c.decoded();
  assert.deepEqual([st.guests, st.adults, st.children, st.checkIn, st.checkOut], [3, 2, 1, "2026-10-17", "2026-10-19"]);
  out = await c.say("3 guests");
  assert.match(out.reply, /Got it — 3 guests\./);
  assert.equal(c.decoded().adults, undefined, "a plain head count replaces the split");
});

/* ---- one message, start to finish ------------------------------------------- */

test("one message carries the whole booking: book, then confirm — nothing asked twice", async () => {
  const c = conversation({ config: { ...CONFIG, bookingRequiresSignIn: true },
                           user: { id: "11111111-2222-4333-8444-555555555555", name: "Account Holder", email: "holder@example.com" } });
  let out = await c.say("Book a luxury room from tomorrow for two nights for 2 adults and 1 child, arriving at 3 pm. My name is Asha Nair, phone 98470 12345, email asha.nair@example.com");
  assert.match(out.reply, /2 adults and 1 child and 1 Luxury room/);
  assert.match(out.reply, /Booking contact: Asha Nair, \+919847012345, asha\.nair@example\.com\./);
  assert.equal(out.ui.panel.type, "rooms");
  assert.equal(c.repo.res.length, 0, "nothing held by the message itself");

  out = await c.tap({ type: "book", roomIds: out.ui.panel.selected });
  assert.equal(out.ui.panel.stage, "review", "straight to the summary: the guest's details are already known");
  assert.equal(out.ui.form, undefined, "no form asking for them again");
  assert.deepEqual(out.ui.panel.guest, { name: "Asha Nair", phone: "+919847012345", email: "asha.nair@example.com" });
  assert.equal((out.reply.match(/until 11:45 AM/g) || []).length, 1, "the hold's end is said once");
  assert.equal(c.repo.res[0].status, "held");

  out = await c.tap(option(out, /^Confirm booking$/).action);
  assert.equal(out.ui.panel.stage, "confirmed");
  assert.equal(out.ui.panel.totalLabel, "₹9,000");
  assert.equal(out.ui.panel.party, "2 adults and 1 child");
  const row = c.repo.res[0];
  assert.deepEqual([row.status, row.check_in, row.check_out, row.num_guests, row.guest_name, row.guest_phone, row.guest_email],
    ["confirmed", "2026-10-17", "2026-10-19", 3, "Asha Nair", "+919847012345", "asha.nair@example.com"]);
});
