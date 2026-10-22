"use strict";

/* A spoken booking, end to end against the real database: the words as
   Whisper writes them, sent through POST /api/chat with the progress stream
   on, at Misty Mountain. Checks that the reservation really is
   in the reservations table — confirmed, at the right hotel, room and price
   — and that a second guest cannot then take the same room.

   Supabase Auth is stubbed for one made-up token, as in booking.test.js, so
   no account is created. June 2027 dates and @test.invalid emails only;
   every row this file creates is removed afterwards, by its reference. */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { EMAIL_DOMAIN, withPg } = require("./_db");

const TOKEN = "test-token-" + crypto.randomBytes(16).toString("hex");
const repoModule = require("../../server/db/repository");
const realCreate = repoModule.createRepository;
repoModule.createRepository = (...args) => {
  const r = realCreate(...args);
  const realGetUser = r.getUser;
  r.getUser = async t => t === TOKEN ? { id: null, email: `voice${EMAIL_DOMAIN}`, name: "Voice Tester" } : realGetUser(t);
  return r;
};
const { handleRequest } = require("../../server/app");

const refs = [];
test.after(async () => {
  await withPg(async c => {
    await c.query("begin");
    await c.query("delete from public.reservations where booking_ref = any($1) or (check_in >= '2027-06-01' and check_in < '2027-07-01' and status = 'held' and hotel_id = 'misty_mountain')", [refs]);
    await c.query("delete from public.guests g where email like $1 and not exists (select 1 from public.reservations x where x.guest_id = g.id)", ["%" + EMAIL_DOMAIN]);
    await c.query("commit");
  });
});

/* One guest's conversation, as the page holds it: the state token and the
   progress steps of each turn. */
function guest(signedIn = true){
  let state = null;
  const turn = async body => {
    const steps = [];
    const headers = { "content-type": "application/json", accept: "application/x-ndjson, application/json" };
    if (signedIn) headers.authorization = "Bearer " + TOKEN;
    const r = await handleRequest({ method: "POST", headers, bodyText: JSON.stringify({ ...body, state }),
                                    clientIp: "db-voice-" + Math.random(), onProgress: s => steps.push(s) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (r.body.state !== undefined) state = r.body.state;
    return { ...r.body, steps };
  };
  return { say: message => turn({ message }) };
}

const row = ref => withPg(c => c.query(
  `select x.hotel_id, x.status, r.room_number, x.check_in::text ci, x.check_out::text co, x.total_price::text total, g.email
     from public.reservations x join public.rooms r on r.id = x.room_id join public.guests g on g.id = x.guest_id
    where x.booking_ref = $1`, [ref])).then(r => r.rows);

for (const [hotel, id, nightly] of [["Misty Mountain", "misty_mountain", 4500]]){
  test(`spoken booking at ${hotel}: really saved, confirmed, at that hotel — and the room is then taken`, async () => {
    const g = guest();
    let out = await g.say(`I want to book a room at ${hotel}.`);
    assert.equal(out.hotel.id, id);
    out = await g.say("June 21st, 2027 to June 23rd, 2027.");
    assert.match(out.reply, /check-in Mon 21 Jun and check-out Wed 23 Jun/);
    out = await g.say("Around 2 PM.");
    out = await g.say("Two adults.");
    assert.match(out.reply, /Which room type/);

    out = await g.say("Luxury, please.");
    assert.equal(out.ui.panel.type, "rooms", out.reply);
    assert.deepEqual(out.steps, ["understand", "availability", "matching", "options"], "the steps shown are the steps run");
    assert.ok(out.ui.panel.available.some(r => r.number === 9), "room 9 is free");

    out = await g.say("I'll take room nine.");
    assert.match(out.reply, /^Room 9 \(Luxury\) is held for you/, out.reply);
    assert.ok(out.steps.includes("hold"));

    out = await g.say(`Voice Tester, 98470 12345, voice at test dot invalid`);
    assert.match(out.reply, /Here's your booking summary/, out.reply);
    assert.equal(out.ui.panel.guest.email, `voice${EMAIL_DOMAIN}`);

    out = await g.say("Yes, confirm the booking.");
    assert.match(out.reply, /^Your booking is confirmed! Your booking reference is MM-[A-Z2-9]{6}\./);
    assert.ok(out.steps.includes("confirm"));
    const ref = out.data.bookingRef;
    refs.push(ref);

    assert.deepEqual(await row(ref), [{
      hotel_id: id, status: "confirmed", room_number: 9, ci: "2027-06-21", co: "2027-06-23",
      total: (nightly * 2).toFixed(2), email: `voice${EMAIL_DOMAIN}`
    }]);

    // Another guest, the same nights: room 9 is no longer offered, and asking
    // for it by voice books nothing.
    const other = guest();
    await other.say(`Book a room at ${hotel} from June 21st, 2027 to June 23rd, 2027 for two adults.`);
    await other.say("2 PM");
    out = await other.say("Luxury.");
    assert.ok(!out.ui.panel.available.some(r => r.number === 9), "room 9 is not offered again");
    out = await other.say("Room nine, please.");
    assert.match(out.reply, /room 9 is no longer available|couldn't find room 9/i, out.reply);
    const n = await withPg(c => c.query(`select count(*)::int n from public.reservations x join public.rooms r on r.id = x.room_id
                                          where x.hotel_id = $1 and r.room_number = 9 and x.check_in < '2027-06-23' and x.check_out > '2027-06-21'
                                            and x.status in ('held','confirmed','checked_in')`, [id]));
    assert.equal(n.rows[0].n, 1, "exactly one booking of room 9 for those nights");
  });
}

test("a signed-out guest is asked to sign in, and nothing is held", async () => {
  const g = guest(false);
  await g.say("Book a room at Misty Mountain from June 25th, 2027 to June 26th, 2027 for one adult.");
  await g.say("3 PM");
  await g.say("Normal.");
  const out = await g.say("Yes, book it.");
  assert.equal(out.error, "sign_in_required");
  const n = await withPg(c => c.query("select count(*)::int n from public.reservations where hotel_id = 'misty_mountain' and check_in = '2027-06-25'"));
  assert.equal(n.rows[0].n, 0);
});

test("one spoken message carries the whole booking: book it, confirm it — saved with every detail", async () => {
  const g = guest();
  let out = await g.say("Book a luxury room from June 14th, 2027 for two nights for two adults and one child, arriving at 3 PM. "
    + "My name is Voice Tester, phone 98470 12345, email voice at test dot invalid.");
  assert.equal(out.hotel.id, "misty_mountain");
  assert.match(out.reply, /2 adults and 1 child and 1 Luxury room/, out.reply);
  assert.match(out.reply, /Booking contact: Voice Tester, \+919847012345, voice@test\.invalid\./, out.reply);
  assert.equal(out.ui.panel.type, "rooms", out.reply);

  out = await g.say("Yes, book it.");
  assert.equal(out.ui.panel.stage, "review", "straight to the summary — nothing asked again");
  assert.equal(out.ui.panel.party, "2 adults and 1 child");
  const room = out.ui.panel.rooms[0].number;

  out = await g.say("Yes, confirm the booking.");
  assert.equal(out.ui.panel.stage, "confirmed", out.reply);
  assert.equal(out.ui.panel.totalLabel, "₹9,000");
  const ref = out.data.bookingRef;
  refs.push(ref);
  assert.deepEqual(await row(ref), [{
    hotel_id: "misty_mountain", status: "confirmed", room_number: room, ci: "2027-06-14", co: "2027-06-16",
    total: "9000.00", email: `voice${EMAIL_DOMAIN}`
  }]);
});
