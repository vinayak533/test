"use strict";

/* Routing in server/chat.js: hotel questions, booking look-ups, Jev and its
   fallback, what goes back to the page's knowledge base, and input hygiene. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { conversation, fakeRepo, HOTEL } = require("./helpers");
const { InputError } = require("../server/sanitize");

function jevSays(intent, iconf, hotel = "none", hconf = 0.9){
  return { ask: async () => ({ intent: { choice: intent, confidence: iconf }, hotel: { choice: hotel, confidence: hconf } }) };
}

/* ---- Misty Mountain is the only hotel ------------------------------------- */

for (const q of ["Which hotels are available?", "Where can I stay?", "Which hotel does this chatbot support?",
                 "Do you have any other hotels?", "list of hotels please"]){
  test(`"${q}" → Misty Mountain is the only hotel, read from the database`, async () => {
    const c = conversation();
    const out = await c.say(q);
    assert.equal(out.handled, true);
    assert.match(out.reply, /^Misty Mountain is currently the only hotel available on this platform\./);
    assert.ok(c.repo.calls.some(([k]) => k === "hotels"));
  });
}

test("the hotel's name comes from the table, not from the code", async () => {
  const repo = fakeRepo();
  repo.listHotels = async () => [{ ...HOTEL, name: "Misty Mountain Estate" }];
  const out = await conversation({ repo }).say("which hotels are available?");
  assert.match(out.reply, /^Misty Mountain Estate is currently the only hotel/);
});

test("another hotel by name: only Misty Mountain is offered, nothing invented", async () => {
  const out = await conversation().say("Do you have rooms at the Taj hotel tonight?");
  assert.match(out.reply, /only help with bookings at Misty Mountain — it's currently the only hotel available on this platform/);
  assert.doesNotMatch(out.reply, /Taj/);
});

test("Jev's hotel choice is used when Jev is configured", async () => {
  const c = conversation({ jev: jevSays("check_room_availability", 0.95, "other_hotel", 0.9) });
  const out = await c.say("rooms at Grand Plaza?");
  assert.match(out.reply, /only hotel available on this platform/);
});

/* ---- Jev ---------------------------------------------------------------- */

test("Jev's intent starts the booking flow", async () => {
  const c = conversation({ jev: jevSays("check_room_availability", 0.93) });
  const out = await c.say("got anything free?");
  assert.match(out.reply, /What date would you like to check in\?/);
  assert.equal(out.source, "jev");
});

test("Jev down: rules take over and still answer", async () => {
  const { JevError } = require("../server/jev/client");
  const jev = { ask: async () => { throw new JevError("timeout", "slow"); } };
  const out = await conversation({ jev }).say("How many rooms are available?");
  assert.equal(out.source, "rules");
  assert.match(out.reply, /What date would you like to check in/);
});

test("a rejected Jev key is not retried on every message", async () => {
  const { JevError } = require("../server/jev/client");
  let calls = 0;
  const jev = { ask: async () => { calls++; throw new JevError("auth", "bad key", 401); } };
  const c = conversation({ jev });
  await c.say("hello");
  await c.say("any rooms?");
  await c.say("which hotels?");
  assert.equal(calls, 1);
});

test("a borderline Jev intent asks before starting", async () => {
  const out = await conversation({ jev: jevSays("check_room_availability", 0.45) }).say("hmm");
  assert.equal(out.kind, "clarify");
  assert.equal(out.reply, "Would you like me to check room availability?");
});

/* ---- what the page answers --------------------------------------------- */

for (const q of ["What time is breakfast?", "Can we book a campfire or barbecue?", "Is there a tea factory tour?",
                 "What are the check-in and check-out times?", "Tell me about the rooms"]){
  test(`"${q}" goes to the page's knowledge base`, async () => {
    const out = await conversation().say(q);
    assert.equal(out.handled, false);
  });
}

test("hotels table down: a booking question gets an error, a general one goes to the page", async () => {
  const repo = fakeRepo({ fail: "hotels" });
  const a = await conversation({ repo }).say("any rooms available?");
  assert.equal(a.kind, "error");
  assert.match(a.reply, /couldn't reach our reservations system/);
  const b = await conversation({ repo }).say("what time is dinner?");
  assert.equal(b.handled, false);
});

/* ---- booking look-up ------------------------------------------------------ */

function bookedRepo(){
  return fakeRepo({ reservations: [{
    ref: "MM-ABC234", room_id: "00000000-0000-4000-8000-000000000007", check_in: "2026-11-02", check_out: "2026-11-04",
    status: "confirmed", num_guests: 2, price: 4500, total_price: 9000,
    guest_name: "Asha Nair", guest_email: "asha@example.com", guest_phone: "+919847012345"
  }] });
}

test("look-up: reference, then email → the booking, with contact details masked", async () => {
  const c = conversation({ repo: bookedRepo() });
  let out = await c.say("Can you check my booking?");
  assert.match(out.reply, /What's your booking reference\?/);
  out = await c.say("mm-abc234");
  assert.match(out.reply, /email address or mobile number used for booking MM-ABC234/);
  out = await c.say("asha@example.com");
  assert.match(out.reply, /I found booking MM-ABC234: 1 room at Misty Mountain from Mon 2 Nov 2026 to Wed 4 Nov 2026, confirmed\./);
  assert.equal(out.ui.panel.guest.email, "as**@example.com");
  assert.match(out.ui.panel.guest.phone, /^\+91 •+2345$/);
});

test("look-up: reference and phone in one message", async () => {
  const out = await conversation({ repo: bookedRepo() }).say("MM-ABC234 98470 12345");
  assert.match(out.reply, /I found booking MM-ABC234/);
});

test("look-up: a wrong contact reveals nothing, and attempts are limited", async () => {
  const c = conversation({ repo: bookedRepo() });
  let out;
  for (let i = 0; i < 3; i++){
    await c.say("MM-ABC234");
    out = await c.say("someone@else.com");
  }
  assert.match(out.reply, /For your security I'll stop here/);
  assert.doesNotMatch(out.reply, /Asha|Nov/);
  assert.equal(c.state, null);
});

test("look-up: holds are never shown as bookings", async () => {
  const repo = bookedRepo();
  repo.res[0].status = "held";
  const out = await conversation({ repo }).say("MM-ABC234 asha@example.com");
  assert.match(out.reply, /couldn't find a booking/);
});

/* ---- input hygiene ----------------------------------------------------------- */

test("input: empty, oversized and non-string messages are rejected", async () => {
  const c = conversation();
  await assert.rejects(c.say(""), InputError);
  await assert.rejects(c.say("x".repeat(501)), InputError);
  await assert.rejects(c.say(42), InputError);
});

test("the guest's words are never logged", async () => {
  const c = conversation({ repo: bookedRepo() });
  await c.say("my email is secret.person@example.com and I want rooms from 20 oct");
  await c.say("MM-ABC234 asha@example.com");
  const all = JSON.stringify(c.log.lines);
  assert.ok(!all.includes("secret.person"));
  assert.ok(!all.includes("asha@example.com"));
});
