"use strict";

/* Live database: the front-desk assistant (mode "desk"), end to end over
   HTTP through server/app.js, against the real rooms, prices and booking
   functions of all three hotels.  npm run test:db

   Supabase Auth is stubbed for two made-up tokens — an agency administrator
   and a Royal Hotel manager — so no account is created. The manager's
   hotel_staff row is real (read by the server with the service-role key),
   made for a throwaway auth.users row and removed afterwards. Bookings use
   June 2027 dates at Misty Mountain and @test.invalid emails; cleanup()
   removes them. */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { withPg, cleanup, EMAIL_DOMAIN } = require("./_db");

const ADMIN_TOKEN = "desk-admin-" + crypto.randomBytes(16).toString("hex");
const MANAGER_TOKEN = "desk-manager-" + crypto.randomBytes(16).toString("hex");
const MANAGER_ID = "00000000-0000-4000-8000-0000000de5c1";

const repoModule = require("../../server/db/repository");
const realCreate = repoModule.createRepository;
repoModule.createRepository = (...args) => {
  const r = realCreate(...args);
  const realGetUser = r.getUser;
  r.getUser = async t => t === ADMIN_TOKEN ? { id: "00000000-0000-4000-8000-0000000ad31a", email: "admin" + EMAIL_DOMAIN, name: "Desk Admin", role: "admin" }
                       : t === MANAGER_TOKEN ? { id: MANAGER_ID, email: "manager" + EMAIL_DOMAIN, name: "Royal Desk", role: "manager" }
                       : realGetUser(t);
  return r;
};
const { handleRequest } = require("../../server/app");

function call(token, hotelId){
  let state = null;
  const turn = async body => {
    const r = await handleRequest({ method: "POST", clientIp: "desk-test-" + Math.random(),
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      bodyText: JSON.stringify({ ...body, state, hotelId, mode: "desk" }) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (r.body.state !== undefined) state = r.body.state;
    return r.body;
  };
  return { say: message => turn({ message }), tap: action => turn({ action }) };
}

test.before(async () => {
  await withPg(async c => {
    await c.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated') on conflict (id) do nothing",
                  [MANAGER_ID, "desk-manager" + EMAIL_DOMAIN]);
    await c.query("insert into public.hotel_staff (user_id, hotel_id) values ($1, 'royal_kuttikkanam') on conflict do nothing", [MANAGER_ID]);
  });
});
test.after(async () => {
  await withPg(async c => {
    await c.query("delete from public.hotel_staff where user_id = $1", [MANAGER_ID]);
    await c.query("delete from auth.users where id = $1", [MANAGER_ID]);
  });
  await cleanup();
});

test("each hotel answers with its own live rooms and prices", async () => {
  const prices = {};
  for (const id of ["misty_mountain", "royal_kuttikkanam", "taj_kuttikkanam"]){
    const out = await call(ADMIN_TOKEN, id).say("What rooms are available from June 21 2027 to June 23 2027?");
    assert.equal(out.hotel.id, id);
    assert.equal(out.ui.panel.type, "rooms", id);
    assert.equal(out.ui.panel.totalRooms, 10);
    prices[id] = [...new Set(out.ui.panel.available.map(r => r.type + " " + r.price))].sort();
  }
  assert.deepEqual(prices, {
    misty_mountain:    ["Luxury 4500", "Normal 2500"],
    royal_kuttikkanam: ["Luxury 5500", "Normal 3000"],
    taj_kuttikkanam:   ["Luxury 7500", "Normal 4000"]
  });
});

test("a hotel manager works at their own hotel only", async () => {
  let out = await call(MANAGER_TOKEN, "royal_kuttikkanam").say("luxury room for 3 adults on 21 June 2027 for 2 nights");
  assert.equal(out.ui.panel.type, "rooms");
  assert.equal(out.request.rooms, 1);
  out = await call(MANAGER_TOKEN, "misty_mountain").say("rooms on 21 June 2027");
  assert.equal(out.error, "desk_forbidden");
  assert.equal(out.ui, undefined, "nothing of Misty Mountain is shown");
});

test("rates come from the rooms table", async () => {
  const out = await call(ADMIN_TOKEN, "taj_kuttikkanam").say("What is the price of a luxury room?");
  assert.equal(out.reply, "Taj Hotel: Luxury ₹7,500 a night (5 rooms, up to 3 guests each). Give me dates to check what's free.");
});

test("a desk booking: held, confirmed only by the button, labelled front desk, never twice", async () => {
  const a = call(ADMIN_TOKEN, "misty_mountain");
  let out = await a.say("Luxury room for 2 adults from 24 June 2027 to 26 June 2027");
  const room = out.ui.panel.available[0];
  out = await a.tap({ type: "book", roomIds: [room.id] });
  assert.ok(out.request.held, out.reply);
  out = await a.tap({ type: "guest", name: "Desk Tester", phone: "98470 12345", email: "desk" + EMAIL_DOMAIN });
  assert.equal(out.ui.panel.stage, "review");
  out = await a.say("yes confirm");
  assert.match(out.reply, /^To book, tap Confirm booking\./);
  out = await a.tap({ type: "confirm" });
  const ref = out.ui.panel.ref;
  assert.match(out.reply, new RegExp("^Booked\\. Reference " + ref));

  const rows = await withPg(c => c.query("select status, source, user_id, guest_email from public.reservations where booking_ref = $1", [ref]));
  assert.deepEqual(rows.rows, [{ status: "confirmed", source: "admin", user_id: null, guest_email: "desk" + EMAIL_DOMAIN }]);

  // A second receptionist, same room, same nights: the room is gone.
  const b = call(ADMIN_TOKEN, "misty_mountain");
  out = await b.say("rooms from 24 June 2027 to 26 June 2027");
  assert.ok(!out.ui.panel.available.some(r => r.id === room.id), "no longer offered");
  out = await b.tap({ type: "book", roomIds: [room.id] });
  assert.ok(!out.request || !out.request.held, "never held twice");
  assert.match(out.reply, /no longer available|aren't available/);
});
