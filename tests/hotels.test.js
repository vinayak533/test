"use strict";

/* Three hotels on one platform: Misty Mountain, Royal Hotel and Taj Hotel,
   ten rooms each. Which hotel a turn is about, independent inventories and
   bookings, switching hotels, and what each hotel's answers may contain.
   Today is Fri 16 Oct 2026. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { conversation, fakeRepo, optionLabels, HOTEL, ROOMS, ROYAL, ROYAL_ROOMS, TAJ, TAJ_ROOMS } = require("./helpers");
const { InputError } = require("../server/sanitize");

const threeHotels = (extra = {}) => fakeRepo({
  hotels: [HOTEL, ROYAL, TAJ],
  roomsByHotel: { [HOTEL.id]: ROOMS, [ROYAL.id]: ROYAL_ROOMS, [TAJ.id]: TAJ_ROOMS },
  ...extra
});

const RICH = "I want to book 1 luxury room from Oct 20 to 22 for 2 guests, arriving at 2pm";
const GUEST = { type: "guest", name: "Asha Nair", phone: "98470 12345", email: "asha@example.com" };

/* Through to a confirmed booking: the rooms offered, or the given ones. */
async function bookThrough(c, roomIds){
  let out = await c.say(RICH);
  assert.equal(out.ui.panel.type, "rooms", out.reply);
  out = await c.tap({ type: "book", roomIds: roomIds || out.ui.panel.selected });
  out = await c.tap(GUEST);
  assert.equal(out.ui.panel.stage, "review", out.reply);
  return c.tap({ type: "confirm" });
}

/* ---- which hotels there are -------------------------------------------------- */

test("which hotels: all three, from the table, each with its own button", async () => {
  const c = conversation({ repo: threeHotels(), hotelId: ROYAL.id });
  const out = await c.say("Which hotels are available?");
  assert.equal(out.reply, "The hotels available on this platform are Misty Mountain, Royal Hotel and Taj Hotel. Which one would you like me to check?");
  // The selected hotel first.
  assert.deepEqual(out.ui.options.map(o => o.action), [
    { type: "start", hotelId: ROYAL.id }, { type: "start", hotelId: HOTEL.id }, { type: "start", hotelId: TAJ.id }
  ]);
  assert.deepEqual(optionLabels(out), ["Book at Royal Hotel", "Book at Misty Mountain", "Book at Taj Hotel"]);
});

test("a hotel that is not on the platform is still never invented", async () => {
  const out = await conversation({ repo: threeHotels() }).say("Do you have rooms at the Hilton hotel tonight?");
  assert.match(out.reply, /^I can only help with bookings at Misty Mountain, Royal Hotel and Taj Hotel\./);
  assert.doesNotMatch(out.reply, /Hilton/);
});

/* ---- which hotel a turn is about --------------------------------------------- */

test("no selection: the site's own hotel, exactly as before", async () => {
  const c = conversation({ repo: threeHotels() });
  const out = await c.say("How many rooms are available?");
  assert.equal(out.reply, "I'd be happy to check room availability at Misty Mountain. What date would you like to check in?");
  assert.deepEqual(out.hotel, { id: HOTEL.id, name: "Misty Mountain" });
  assert.equal(c.decoded().hotelId, HOTEL.id);
});

test("the page's selection decides the hotel, and the reply says which", async () => {
  const c = conversation({ repo: threeHotels(), hotelId: TAJ.id });
  const out = await c.say("How many rooms are available?");
  assert.equal(out.reply, "I'd be happy to check room availability at Taj Hotel. What date would you like to check in?");
  assert.deepEqual(out.hotel, { id: TAJ.id, name: "Taj Hotel" });
  assert.equal(c.decoded().hotelId, TAJ.id);
});

test("a hotel named in the message wins over the selection", async () => {
  const c = conversation({ repo: threeHotels(), hotelId: HOTEL.id });
  const out = await c.say("Do you have rooms at Royal Hotel from 20 Oct to 22 Oct?");
  assert.equal(out.hotel.id, ROYAL.id);
  assert.match(out.reply, /Royal Hotel/);
  assert.equal(c.decoded().hotelId, ROYAL.id);
  assert.equal(c.hotelId, ROYAL.id, "the page's selector follows");
});

test("an unknown or malformed hotel id is refused, not guessed", async () => {
  const c = conversation({ repo: threeHotels() });
  await assert.rejects(c.tap({ type: "start", hotelId: "hilton_kochi" }), InputError);
  await assert.rejects(c.tap({ type: "start", hotelId: "Not An Id!" }), InputError);
  await assert.rejects(c.tap({ type: "switch" }), InputError);
  // An unknown selection from the page falls back to the site's hotel.
  const out = await conversation({ repo: threeHotels(), hotelId: "hilton_kochi" }).say("How many rooms are available?");
  assert.equal(out.hotel.id, HOTEL.id);
});

/* ---- each hotel's own rooms and rates ---------------------------------------- */

test("room types and rates come from the chosen hotel's rooms", async () => {
  const taj = await conversation({ repo: threeHotels(), hotelId: TAJ.id }).say("What types of rooms do you have?");
  assert.match(taj.reply, /^Taj Hotel has 10 rooms: 5 Normal rooms at ₹4,000 a night and 5 Luxury rooms at ₹7,500 a night\./);
  const royal = await conversation({ repo: threeHotels() }).say("how much is a luxury room at royal hotel?");
  assert.match(royal.reply, /^Royal Hotel has 10 rooms: 6 Normal rooms at ₹3,000 a night and 4 Luxury rooms at ₹5,500 a night\./);
  const misty = await conversation({ repo: threeHotels() }).say("How many rooms do you have?");
  assert.match(misty.reply, /^Misty Mountain has 10 rooms: 6 Normal rooms at ₹2,500 a night and 4 Luxury rooms at ₹4,500 a night\./);
});

test("availability lists only the chosen hotel's rooms, at its rates", async () => {
  const c = conversation({ repo: threeHotels(), hotelId: TAJ.id });
  const out = await c.say(RICH);
  assert.equal(out.ui.panel.hotel, "Taj Hotel");
  assert.deepEqual(out.ui.panel.available.map(r => r.id), TAJ_ROOMS.filter(r => r.room_type === "Luxury").map(r => r.id));
  assert.deepEqual(out.ui.panel.available.map(r => r.number), [6, 7, 8, 9, 10]);
  assert.equal(out.ui.panel.available[0].price, 7500);
  assert.ok(c.repo.calls.filter(([k]) => k === "availability").every(([, , , h]) => h === TAJ.id));
});

/* ---- independent bookings ---------------------------------------------------- */

test("the same room number on the same nights can be booked at every hotel", async () => {
  const repo = threeHotels();
  for (const [h, rooms] of [[HOTEL, ROOMS], [ROYAL, ROYAL_ROOMS], [TAJ, TAJ_ROOMS]]){
    const out = await bookThrough(conversation({ repo, hotelId: h.id }), [rooms[6].id]);   // room 7
    assert.match(out.reply, new RegExp(`^Your booking is confirmed!.*welcoming you to ${h.name}`), out.reply);
  }
  const live = repo.res.filter(r => r.status === "confirmed");
  assert.equal(live.length, 3);
  assert.deepEqual(new Set(live.map(r => r.hotel_id)), new Set([HOTEL.id, ROYAL.id, TAJ.id]));
  // Every booking holds a room of its own hotel.
  for (const r of live){
    const inv = { [HOTEL.id]: ROOMS, [ROYAL.id]: ROYAL_ROOMS, [TAJ.id]: TAJ_ROOMS }[r.hotel_id];
    assert.ok(inv.some(x => x.id === r.room_id), "room belongs to " + r.hotel_id);
  }
});

test("a full hotel does not make another hotel look full", async () => {
  const repo = threeHotels({ reservations: ROYAL_ROOMS.map(r => ({
    ref: "MM-ROYAL" + r.room_number, hotel_id: ROYAL.id, room_id: r.id, check_in: "2026-10-19", check_out: "2026-10-23",
    status: "confirmed", num_guests: 2, price: r.price_per_night, total_price: r.price_per_night * 4
  })) });
  const royal = await conversation({ repo, hotelId: ROYAL.id }).say(RICH);
  assert.match(royal.reply, /Royal Hotel is fully booked/);
  const taj = await conversation({ repo, hotelId: TAJ.id }).say(RICH);
  assert.match(taj.reply, /5 Luxury rooms are available at Taj Hotel/);
  const misty = await conversation({ repo }).say(RICH);
  assert.match(misty.reply, /4 Luxury rooms are available at Misty Mountain/);
});

test("a hold cannot take another hotel's room", async () => {
  const c = conversation({ repo: threeHotels(), hotelId: ROYAL.id });
  await c.say(RICH);
  const out = await c.tap({ type: "book", roomIds: [TAJ_ROOMS[6].id] });
  assert.match(out.reply, /aren't available to book/);
  assert.ok(!c.repo.calls.some(([k]) => k === "hold"), "nothing was held");
});

/* ---- switching hotels -------------------------------------------------------- */

test("mid-booking, naming another hotel offers to switch and keeps the booking until asked", async () => {
  const c = conversation({ repo: threeHotels(), hotelId: HOTEL.id });
  let out = await c.say(RICH);
  out = await c.tap({ type: "book", roomIds: out.ui.panel.selected });
  assert.ok(c.decoded().hold, "a room is held at Misty Mountain");

  out = await c.say("Actually, do you have rooms at the Taj hotel?");
  assert.equal(out.kind, "clarify");
  assert.match(out.reply, /^You're in the middle of a booking at Misty Mountain\. Would you like to book at Taj Hotel instead\?/);
  assert.deepEqual(optionLabels(out), ["Book at Taj Hotel instead", "Continue at Misty Mountain"]);
  assert.ok(c.decoded().hold, "still held");
  assert.ok(!c.repo.calls.some(([k]) => k === "release"));

  out = await c.tap(out.ui.options[0].action);
  assert.equal(out.reply, "I'd be happy to check room availability at Taj Hotel. What date would you like to check in?");
  assert.ok(c.repo.calls.some(([k]) => k === "release"), "the Misty Mountain hold is given back at once");
  assert.equal(c.decoded().hotelId, TAJ.id);
  assert.equal(c.decoded().hold, undefined);
});

test("continuing at the current hotel after the offer picks up where it was", async () => {
  const c = conversation({ repo: threeHotels() });
  await c.say(RICH);
  const offer = await c.say("what about royal hotel?");
  const out = await c.tap(offer.ui.options[1].action);
  assert.equal(out.ui.panel.type, "rooms");
  assert.equal(out.ui.panel.hotel, "Misty Mountain");
});

test("switching on the page mid-booking releases the hold and says so", async () => {
  const c = conversation({ repo: threeHotels(), hotelId: HOTEL.id });
  let out = await c.say(RICH);
  await c.tap({ type: "book", roomIds: out.ui.panel.selected });
  out = await c.tap({ type: "switch", hotelId: ROYAL.id });
  assert.equal(out.reply, "You're now looking at Royal Hotel. I've stopped the booking at Misty Mountain and released the room you were holding — nothing was booked there. Would you like me to check room availability?");
  assert.equal(c.state, null);
  assert.deepEqual(out.hotel, { id: ROYAL.id, name: "Royal Hotel" });
  assert.deepEqual(out.ui.options[0].action, { type: "start", hotelId: ROYAL.id });
  assert.equal(c.repo.res[0].status, "expired");
});

/* ---- answers outside the booking --------------------------------------------- */

test("general questions: the site's hotel goes to the page's knowledge base; the others get an honest limit", async () => {
  const misty = await conversation({ repo: threeHotels() }).say("Is there a swimming pool?");
  assert.equal(misty.handled, false);
  assert.equal(misty.hotel.id, HOTEL.id);

  const royal = await conversation({ repo: threeHotels(), hotelId: ROYAL.id }).say("Is there a swimming pool?");
  assert.equal(royal.handled, true);
  assert.match(royal.reply, /^For Royal Hotel I can tell you about the rooms and rates, check live availability, make a booking and look one up\. I don't have other details about Royal Hotel yet/);
  assert.deepEqual(royal.ui.options[0].action, { type: "start", hotelId: ROYAL.id });
});

test("a side question mid-booking at another hotel is answered, and the booking's question follows", async () => {
  const c = conversation({ repo: threeHotels(), hotelId: TAJ.id });
  const before = await c.say(RICH);
  const out = await c.say("do you serve breakfast?");
  assert.equal(out.handled, true);
  assert.match(out.reply, /^For Taj Hotel I can tell you about the rooms and rates/);
  assert.equal(out.ui.panel && out.ui.panel.type, before.ui.panel && before.ui.panel.type, "the same step is shown again");
  assert.equal(c.decoded().hotelId, TAJ.id, "the booking is kept");
});

test("looking up a booking names the hotel it is at, whichever is selected", async () => {
  const repo = threeHotels({ reservations: [{
    ref: "MM-TAJ234", hotel_id: TAJ.id, room_id: TAJ_ROOMS[0].id, check_in: "2026-11-02", check_out: "2026-11-04",
    status: "confirmed", num_guests: 2, price: 4000, total_price: 8000,
    guest_name: "Asha Nair", guest_email: "asha@example.com", guest_phone: "+919847012345"
  }] });
  const out = await conversation({ repo, hotelId: HOTEL.id }).say("MM-TAJ234 asha@example.com");
  assert.match(out.reply, /^I found booking MM-TAJ234: 1 room at Taj Hotel/);
  assert.equal(out.ui.panel.hotel, "Taj Hotel");
});
