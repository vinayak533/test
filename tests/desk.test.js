"use strict";

/* The front-desk assistant (mode: "desk"): a receptionist on the phone with a
   caller, through server/chat.js handleDesk and the same booking flow, against
   the in-memory repository. Today is Fri 16 Oct 2026, 11:30 in Kerala. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { conversation, fakeRepo, optionLabels, option, uuid, HOTEL, ROOMS, ROYAL, ROYAL_ROOMS, TAJ, TAJ_ROOMS } = require("./helpers");

const MANAGER = { id: "11111111-1111-4111-8111-111111111111", email: "desk@example.com", name: "Front Desk", role: "manager", hotels: ["misty_mountain"] };
const ADMIN = { id: "22222222-2222-4222-8222-222222222222", email: "boss@example.com", name: "Agency", role: "admin" };

const three = () => fakeRepo({ hotels: [HOTEL, ROYAL, TAJ],
  roomsByHotel: { misty_mountain: ROOMS, royal_kuttikkanam: ROYAL_ROOMS, taj_kuttikkanam: TAJ_ROOMS } });
const desk = (opts = {}) => conversation({ mode: "desk", user: MANAGER, hotelId: "misty_mountain", ...opts });
const confirmed = (room, check_in, check_out) =>
  ({ ref: "MM-OLD" + room, room_id: uuid(room), check_in, check_out, status: "confirmed", num_guests: 2, price: 2500, total_price: 5000 });

/* ---- who may use it -------------------------------------------------------- */

test("the desk needs a signed-in staff account for that hotel", async () => {
  let c = desk({ user: null });
  let out = await c.say("rooms tonight");
  assert.equal(out.error, "desk_sign_in");
  assert.ok(!c.repo.calls.some(([k]) => k === "availability"), "nothing is read for a signed-out page");

  c = desk({ user: { ...MANAGER, role: null } });                     // a guest account
  out = await c.say("rooms tonight");
  assert.equal(out.error, "desk_forbidden");

  c = desk({ repo: three(), hotelId: "royal_kuttikkanam" });         // a Misty Mountain manager
  out = await c.say("rooms tonight");
  assert.equal(out.error, "desk_forbidden");
  assert.ok(!c.repo.calls.some(([k]) => k === "availability"));

  c = desk({ repo: three(), user: ADMIN, hotelId: "taj_kuttikkanam" });   // the agency: every hotel
  out = await c.say("rooms tonight");
  assert.equal(out.ui.panel.type, "rooms");
  assert.equal(out.hotel.id, "taj_kuttikkanam");
});

test("the desk never asks Jev: the rules answer at once", async () => {
  let asked = 0;
  const jev = { classify: async () => { asked++; throw new Error("should not be called"); } };
  const c = desk({ jev });
  await c.say("Do you have any rooms available for today?");
  assert.equal(asked, 0);
});

/* ---- the calls from the brief --------------------------------------------- */

test("“any rooms available for today?” shows tonight at once, one night assumed", async () => {
  const c = desk({ repo: fakeRepo({ reservations: [confirmed(1, "2026-10-16", "2026-10-18")] }) });
  const out = await c.say("Do you have any rooms available for today?");
  assert.equal(out.ui.panel.type, "rooms", "no question first: straight to availability");
  assert.equal(out.ui.panel.checkIn, "2026-10-16");
  assert.equal(out.ui.panel.checkOut, "2026-10-17");
  assert.equal(out.ui.panel.assumedNights, true);
  assert.match(out.reply, /^9 rooms free for Fri 16 Oct 2026 to Sat 17 Oct 2026 \(1 night\)/);
  assert.match(out.reply, /One night assumed/);
  assert.deepEqual(out.ui.panel.selected, [], "nothing ticked without a party");
  assert.equal(out.ui.panel.rooms.length, 10, "every room's state for the night strip");
  assert.equal(out.ui.panel.rooms.find(r => r.number === 1).free, false);
  assert.equal(out.request.assumedNights, true);
  assert.equal(out.request.nights, 1);
  assert.ok(!/arrive/i.test(out.reply), "the arrival time is never asked");
});

test("“luxury room for three adults from today for two nights”: every detail kept, checked, shown", async () => {
  const c = desk();
  const out = await c.say("Check luxury rooms for three adults from today for two nights");
  assert.equal(out.ui.panel.type, "rooms");
  assert.deepEqual([out.request.checkIn, out.request.checkOut, out.request.nights], ["2026-10-16", "2026-10-18", 2]);
  assert.equal(out.request.assumedNights, false);
  assert.equal(out.request.guests, 3);
  assert.equal(out.request.party, "3 adults");
  assert.equal(out.request.roomType, "Luxury");
  assert.equal(out.request.rooms, 1, "rooms follow from the party");
  assert.equal(out.request.roomsAuto, true);
  assert.deepEqual(out.ui.panel.available.map(r => r.number), [7, 8, 9, 10]);
  assert.equal(out.ui.panel.available[0].stayTotal, 9000);
  assert.equal(out.ui.panel.selected.length, 1, "one room suggested");
  assert.match(out.reply, /1 room suits 3 adults/);
});

test("“luxury room for three adults for two nights” asks only for the date, then keeps the rest", async () => {
  const c = desk();
  let out = await c.say("Do you have a luxury room for three adults for two nights?");
  assert.equal(out.reply, "Which check-in date?");
  assert.ok(optionLabels(out).some(l => /^Today/.test(l)));
  assert.equal(out.request.guests, 3);
  assert.equal(out.request.roomType, "Luxury");
  assert.equal(out.request.nights, 2);

  out = await c.tap(option(out, /^Today/).action);
  assert.equal(out.ui.panel.type, "rooms");
  assert.equal(out.ui.panel.checkOut, "2026-10-18", "the two nights said earlier are used, not one assumed");
  assert.equal(out.request.assumedNights, false);
  assert.equal(out.request.guests, 3, "never asked again");
});

test("“what rooms are available from October 25 to October 28?” lists every free room", async () => {
  const c = desk({ repo: fakeRepo({ reservations: [confirmed(7, "2026-10-26", "2026-10-27")] }) });
  const out = await c.say("What rooms are available from October 25 to October 28?");
  assert.equal(out.ui.panel.type, "rooms");
  assert.equal(out.ui.panel.nights, 3);
  assert.deepEqual(out.ui.panel.available.map(r => r.number), [1, 2, 3, 4, 5, 6, 8, 9, 10]);
  assert.match(out.reply, /Normal rooms 1, 2, 3, 4, 5 and 6 at ₹2,500 per night and Luxury rooms 8, 9 and 10 at ₹4,500 per night/);
});

test("“what is the price of a luxury room?” answers from the rooms table and keeps the search", async () => {
  const c = desk();
  await c.say("2 adults tomorrow for 3 nights");
  const before = c.state;
  const out = await c.say("What is the price of a luxury room?");
  assert.equal(out.reply, "Misty Mountain: Luxury ₹4,500 a night (4 rooms, up to 3 guests each). Give me dates to check what's free.");
  assert.equal(out.ui.panel.type, "rates");
  assert.deepEqual(out.ui.panel.types.map(t => [t.type, t.price]), [["Normal", 2500], ["Luxury", 4500]]);
  assert.equal(out.state, undefined, "the search in progress is left alone");
  assert.equal(c.state, before);
  assert.equal(out.request.guests, 2);
  assert.equal(optionLabels(out)[0], "Back to the search");
});

test("“can I book two rooms for a family?” asks for the date, and the rooms stay two", async () => {
  const c = desk();
  let out = await c.say("Can I book two rooms for a family?");
  assert.equal(out.reply, "Which check-in date?");
  assert.equal(out.request.rooms, 2);
  out = await c.say("from 20 Oct to 22 Oct");
  assert.equal(out.ui.panel.type, "rooms");
  assert.equal(out.ui.panel.need, 2);
  assert.equal(out.ui.panel.selected.length, 2);
});

/* ---- details over several messages ------------------------------------------ */

test("details given over several messages are combined, and a change replaces only itself", async () => {
  const c = desk();
  await c.say("rooms on 20 Oct");
  let out = await c.say("for 4 adults and 1 child");
  assert.equal(out.request.guests, 5);
  assert.equal(out.request.rooms, 2, "5 guests need 2 rooms of 3");
  assert.equal(out.request.checkIn, "2026-10-20");
  out = await c.say("make it 3 nights");
  assert.deepEqual([out.request.checkIn, out.request.checkOut, out.request.assumedNights], ["2026-10-20", "2026-10-23", false]);
  assert.equal(out.request.guests, 5, "the party is kept");
  out = await c.say("luxury only");
  assert.equal(out.request.roomType, "Luxury");
  assert.deepEqual(out.ui.panel.available.map(r => r.number), [7, 8, 9, 10]);
  out = await c.say("actually check in on 21 Oct");
  assert.equal(out.request.checkIn, "2026-10-21");
  assert.equal(out.request.checkOut, "2026-10-23", "the stated check-out stays");
});

test("an assumed one-night stay moves with a new check-in date", async () => {
  const c = desk();
  await c.say("rooms tonight");
  const out = await c.say("sorry, tomorrow");
  assert.deepEqual([out.request.checkIn, out.request.checkOut, out.request.assumedNights], ["2026-10-17", "2026-10-18", true]);
  assert.ok(!/cleared your check-out/.test(out.reply));
});

/* ---- nothing free --------------------------------------------------------- */

test("nothing of that type free: says so, offers the other type and nearby dates", async () => {
  const lux = [7, 8, 9, 10].map(n => confirmed(n, "2026-10-20", "2026-10-22"));
  const c = desk({ repo: fakeRepo({ reservations: lux }) });
  const out = await c.say("luxury room for 2 adults from 20 Oct to 22 Oct");
  assert.equal(out.ui.panel.type, "unavailable");
  assert.match(out.reply, /^No Luxury rooms are free for Tue 20 Oct 2026 to Thu 22 Oct 2026 \(2 nights\)\. 6 rooms of another type are available/);
  assert.ok(optionLabels(out).includes("See Normal rooms (6 free)"));
  assert.ok(optionLabels(out).includes("Thu 22 Oct – Sat 24 Oct (4 free)"), "the stay two days later works");
  assert.ok(!optionLabels(out).some(l => /^Wed 21 Oct/.test(l)), "one day later still overlaps the bookings");
  assert.deepEqual(out.ui.panel.freeByType, [{ type: "Normal", free: 6 }, { type: "Luxury", free: 0 }]);

  // Tapping a nearby stay moves both dates, keeping everything else.
  const next = await c.tap(option(out, /^Thu 22 Oct/).action);
  assert.equal(next.ui.panel.type, "rooms");
  assert.deepEqual([next.request.checkIn, next.request.checkOut, next.request.roomType, next.request.guests], ["2026-10-22", "2026-10-24", "Luxury", 2]);
});

test("fully booked: says so plainly", async () => {
  const all = ROOMS.map(r => confirmed(r.room_number, "2026-10-16", "2026-10-17"));
  const c = desk({ repo: fakeRepo({ reservations: all }) });
  const out = await c.say("any rooms tonight?");
  assert.equal(out.ui.panel.type, "unavailable");
  assert.match(out.reply, /^Misty Mountain is fully booked for/);
  assert.ok(optionLabels(out).some(l => /^Sat 17 Oct – Sun 18 Oct \(10 free\)$/.test(l)));
});

/* ---- booking ------------------------------------------------------------- */

test("booking at the desk: tick rooms, party asked once, hold, details, button-only confirm", async () => {
  const c = desk();
  let out = await c.say("rooms from 20 Oct to 22 Oct");
  const r7 = out.ui.panel.available.find(r => r.number === 7);
  out = await c.tap({ type: "book", roomIds: [r7.id] });
  assert.equal(out.reply, "How many guests in room 7?");
  assert.ok(!c.repo.calls.some(([k]) => k === "hold"), "nothing held before the party is known");

  out = await c.say("2 adults");
  assert.match(out.reply, /^Room 7 \(Luxury\) is held until .* — 2 nights, ₹9,000 in total\. Not booked until you confirm\. Take the caller's full name, mobile number and email address\.$/);
  assert.equal(out.ui.form.type, "guest");
  assert.equal(out.ui.form.name, "", "never prefilled with the receptionist's own account");
  assert.equal(out.ui.form.email, "");
  assert.equal(out.request.held.ref, "MM-TESTA");

  out = await c.tap({ type: "guest", name: "Asha Nair", phone: "98470 12345", email: "asha@example.com", arrival: "15:00" });
  assert.equal(out.ui.panel.stage, "review");
  assert.equal(out.ui.panel.arrival, "3:00 PM");
  assert.equal(optionLabels(out)[0], "Confirm booking");

  // Text never confirms at the desk, typed or spoken.
  out = await c.say("yes confirm the booking");
  assert.match(out.reply, /^To book, tap Confirm booking\./);
  assert.ok(!c.repo.calls.some(([k]) => k === "confirm"));

  out = await c.tap({ type: "confirm" });
  assert.match(out.reply, /^Booked\. Reference MM-TESTA — read it to the caller: Misty Mountain, Tue 20 Oct 2026 to Thu 22 Oct 2026, ₹9,000 in total\.$/);
  const conf = c.repo.calls.find(([k]) => k === "confirm")[1];
  assert.equal(conf.userId, null, "not linked to the receptionist's account");
  assert.equal(conf.arrival, "15:00");
  assert.ok(c.repo.res.every(r => r.source === "admin"), "shown as a front-desk booking");
  assert.deepEqual(optionLabels(out), ["New caller"]);
});

test("a room ticked by another booking in the meantime is never double-booked", async () => {
  const repo = fakeRepo();
  const c = desk({ repo });
  let out = await c.say("2 adults from 20 Oct to 22 Oct luxury");
  const pick = out.ui.panel.selected;
  // Someone else books that very room before the receptionist taps Book.
  repo.res.push({ ref: "MM-OTHER", room_id: pick[0], check_in: "2026-10-20", check_out: "2026-10-22", status: "confirmed", num_guests: 2, price: 4500, total_price: 9000 });
  out = await c.tap({ type: "book", roomIds: pick });
  assert.match(out.reply, /no longer available for your dates/);
  assert.equal(out.ui.panel.type, "rooms");
  assert.ok(!out.ui.panel.available.some(r => r.id === pick[0]));
  assert.ok(!repo.calls.some(([k]) => k === "hold"));
});

test("rooms worked out from the party follow what the receptionist ticks", async () => {
  const c = desk();
  let out = await c.say("4 guests on 20 Oct for 2 nights");
  assert.equal(out.request.rooms, 2);
  const ids = out.ui.panel.available.filter(r => [1, 2, 3].includes(r.number)).map(r => r.id);
  out = await c.tap({ type: "book", roomIds: ids });
  assert.match(out.reply, /^Rooms 1, 2 and 3 are held/);
  const hold = c.repo.calls.find(([k]) => k === "hold")[1];
  assert.deepEqual(hold.guests.reduce((a, b) => a + b, 0), 4);

  const c2 = desk();
  out = await c2.say("2 guests on 20 Oct for 2 nights");
  const many = out.ui.panel.available.slice(0, 3).map(r => r.id);
  out = await c2.tap({ type: "book", roomIds: many });
  assert.match(out.reply, /Each room needs at least one guest, so 2 guests can take at most 2 rooms/);
});

/* ---- one hotel at a time -------------------------------------------------- */

test("each hotel's own rooms and prices, never mixed", async () => {
  const repo = three();
  const c = desk({ repo, user: ADMIN, hotelId: "royal_kuttikkanam" });
  let out = await c.say("luxury room for 2 adults on 20 Oct for 2 nights");
  assert.equal(out.hotel.id, "royal_kuttikkanam");
  assert.ok(out.ui.panel.available.every(r => ROYAL_ROOMS.some(x => x.id === r.id)));
  assert.equal(out.ui.panel.available[0].priceLabel, "₹5,500");
  assert.ok(repo.calls.filter(([k]) => k === "availability").every(a => a[3] === "royal_kuttikkanam"));

  // Naming another hotel moves nothing.
  out = await c.say("what about Taj Hotel?");
  assert.match(out.reply, /^This desk is working on Royal Hotel\. To check Taj Hotel, switch hotel in the menu/);
  assert.equal(out.state, undefined);
  assert.equal(out.hotel.id, "royal_kuttikkanam");
});

test("switching hotel in the menu closes the old search and gives its hold back", async () => {
  const repo = three();
  const c = desk({ repo, user: ADMIN, hotelId: "royal_kuttikkanam" });
  let out = await c.say("2 adults on 20 Oct for 2 nights");
  out = await c.tap({ type: "book", roomIds: out.ui.panel.selected });
  assert.ok(repo.res.some(r => r.status === "held" && r.hotel_id === "royal_kuttikkanam"));

  c.hotelId = "taj_kuttikkanam";                      // the menu, with the old state still in the page
  out = await c.say("luxury rooms tonight");
  assert.ok(repo.res.every(r => r.status !== "held"), "the Royal Hotel hold is released");
  assert.equal(out.hotel.id, "taj_kuttikkanam");
  assert.ok(out.ui.panel.available.every(r => TAJ_ROOMS.some(x => x.id === r.id)));
  assert.equal(out.request.guests, null, "nothing of the Royal Hotel search carries over");
});

test("a desk action cannot move the conversation to another hotel", async () => {
  const c = desk({ repo: three(), user: ADMIN });
  await assert.rejects(() => c.tap({ type: "start", hotelId: "taj_kuttikkanam" }), /desk changes hotel/);
  await assert.rejects(() => c.tap({ type: "switch", hotelId: "taj_kuttikkanam" }), /desk changes hotel/);
});

test("desk and guest conversations never share state", async () => {
  const d = desk();
  await d.say("2 adults on 20 Oct for 2 nights");
  const g = conversation({ user: MANAGER });
  g.state = d.state;                                  // a desk token sent to the guest ChatBot
  const out = await g.say("3 PM");
  assert.equal(out.handled, false, "the guest ChatBot reads it as a fresh message");
  assert.equal(out.state, undefined, "and starts no booking from the desk's");
});

/* ---- everything else ------------------------------------------------------ */

test("a booking reference points to the Reservations search, scoped to the hotel", async () => {
  const c = desk();
  const out = await c.say("find booking MM-AB12CD");
  assert.equal(out.reply, "To open booking MM-AB12CD, search for it in Reservations.");
  assert.deepEqual(out.data, { type: "lookup", bookingRef: "MM-AB12CD" });
  assert.ok(!c.repo.calls.some(([k]) => k === "find"));
});

test("something that is not about rooms gets a short pointer, not a guess", async () => {
  const c = desk();
  const out = await c.say("what time does the restaurant open?");
  assert.equal(out.kind, "clarify");
  assert.match(out.reply, /^I check rooms, rates and availability at Misty Mountain\./);
});

test("the database being unreachable is said, never a number", async () => {
  const c = desk({ repo: fakeRepo({ fail: "availability" }) });
  const out = await c.say("rooms tonight");
  assert.equal(out.kind, "error");
  assert.match(out.reply, /couldn't reach our reservations system/);
  assert.ok(!/\d+ rooms? free/.test(out.reply));
});
