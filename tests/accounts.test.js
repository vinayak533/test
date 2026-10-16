"use strict";

/* Guest accounts and live availability in the ChatBot: booking needs a
   signed-in guest, the booking is tied to that account, and availability
   always comes from the reservations — a booked room is never offered.
   Today is Fri 16 Oct 2026. */

const test = require("node:test");
const assert = require("node:assert/strict");
const { conversation, fakeRepo, optionLabels, CONFIG, uuid } = require("./helpers");

const LOCKED = { ...CONFIG, bookingRequiresSignIn: true };
const GUEST = { id: "11111111-2222-4333-8444-555555555555", email: "asha@example.com", name: "Asha Nair" };

async function toRooms(c, type = "any"){
  await c.say("How many rooms are available?");
  await c.tap({ type: "set", slot: "checkIn", value: "2026-10-20" });
  await c.tap({ type: "set", slot: "arrival", value: "14:00" });
  await c.tap({ type: "set", slot: "checkOut", value: "2026-10-22" });
  await c.tap({ type: "set", slot: "party", value: { guests: 2, rooms: 1 } });
  return c.tap({ type: "set", slot: "roomType", value: type });
}

test("a new conversation asks for dates before giving any availability figure", async () => {
  const c = conversation({ config: LOCKED });
  const out = await c.say("How many rooms are available?");
  assert.match(out.reply, /What date would you like to check in\?/);
  assert.ok(!c.repo.calls.some(([k]) => k === "availability"), "no count before the dates are known");
});

test("a booked room is never offered: room 1 booked → rooms 2–10 only", async () => {
  const repo = fakeRepo({ reservations: [
    { ref: "MM-BOOKD1", room_id: uuid(1), check_in: "2026-10-19", check_out: "2026-10-21", status: "confirmed", num_guests: 2, price: 2500, total_price: 5000 }
  ] });
  const c = conversation({ repo, config: LOCKED });
  const out = await toRooms(c);
  assert.deepEqual(out.ui.panel.available.map(r => r.number), [2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.match(out.reply, /^Good news! 9 rooms are available/);
  assert.doesNotMatch(out.reply, /\b1,/);
  assert.equal(out.data.availableRooms, 9);
});

test("a cancelled booking frees the room again", async () => {
  const repo = fakeRepo({ reservations: [
    { ref: "MM-GONE01", room_id: uuid(1), check_in: "2026-10-19", check_out: "2026-10-21", status: "cancelled", num_guests: 2, price: 2500, total_price: 5000 }
  ] });
  const out = await toRooms(conversation({ repo, config: LOCKED }));
  assert.equal(out.ui.panel.available.length, 10);
});

test("signed out: availability is shown, but holding a room asks the guest to sign in", async () => {
  const c = conversation({ config: LOCKED });
  const rooms = await toRooms(c, "Luxury");
  assert.equal(rooms.ui.panel.type, "rooms");
  const out = await c.tap({ type: "book", roomIds: [uuid(8)] });
  assert.equal(out.error, "sign_in_required");
  assert.equal(out.ui.auth, true, "the page shows its sign-in / sign-up buttons");
  assert.ok(optionLabels(out).includes("Continue booking"));
  assert.ok(!c.repo.calls.some(([k]) => k === "hold"), "nothing is held for a signed-out guest");
  assert.equal(c.decoded().roomType, "Luxury", "the conversation keeps its place");
});

test("after signing in, Continue booking carries on and the booking belongs to the account", async () => {
  const c = conversation({ config: LOCKED });
  await toRooms(c, "Luxury");
  const gate = await c.tap({ type: "book", roomIds: [uuid(8)] });
  c.signIn(GUEST);
  let out = await c.tap(gate.ui.options[0].action);
  assert.match(out.reply, /Room 8 \(Luxury\) is held for you/);
  assert.equal(out.ui.form.name, "Asha Nair", "the form starts from the account's name");
  assert.equal(out.ui.form.email, "asha@example.com", "and its email");
  out = await c.tap({ type: "guest", name: "Asha Nair", phone: "98470 12345", email: "asha@example.com" });
  out = await c.tap({ type: "confirm" });
  assert.match(out.reply, /Your booking is confirmed!/);
  const confirmCall = c.repo.calls.find(([k]) => k === "confirm")[1];
  assert.equal(confirmCall.userId, GUEST.id);
  assert.ok(c.repo.res.filter(r => r.status === "confirmed").every(r => r.user_id === GUEST.id));
});

test("signing out between hold and confirm stops the confirm", async () => {
  const c = conversation({ config: LOCKED, user: GUEST });
  await toRooms(c);
  await c.tap({ type: "book", roomIds: [uuid(3)] });
  await c.tap({ type: "guest", name: "Asha Nair", phone: "98470 12345", email: "asha@example.com" });
  c.signIn(null);
  const out = await c.tap({ type: "confirm" });
  assert.equal(out.error, "sign_in_required");
  assert.ok(!c.repo.calls.some(([k]) => k === "confirm"));
});

test("when Auth cannot be reached, nothing is held and the guest is told plainly", async () => {
  const c = conversation({ config: LOCKED, authError: true });
  await toRooms(c);
  const out = await c.tap({ type: "book", roomIds: [uuid(3)] });
  assert.equal(out.error, "auth_unavailable");
  assert.match(out.reply, /Nothing has been booked/);
  assert.ok(!c.repo.calls.some(([k]) => k === "hold"));
});

test("two guests, one room: the second is told it was just booked and shown what is left", async () => {
  const repo = fakeRepo();
  const a = conversation({ repo, config: LOCKED, user: GUEST });
  const b = conversation({ repo, config: LOCKED, user: { ...GUEST, id: "99999999-2222-4333-8444-555555555555" } });
  await toRooms(a); await toRooms(b);
  const first = await a.tap({ type: "book", roomIds: [uuid(5)] });
  assert.match(first.reply, /Room 5 \(Normal\) is held/);
  const second = await b.tap({ type: "book", roomIds: [uuid(5)] });
  assert.match(second.reply, /no longer available|just booked/);
  assert.ok(!second.ui.panel.available.some(r => r.number === 5));
});
