"use strict";

/* Live database: availability, holds, bookings, concurrency, admin status
   changes, look-ups and one full ChatBot conversation.  npm run test:db
   Uses June 2027 dates only; every row created is removed afterwards. */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { HOTEL, EMAIL_DOMAIN, withPg, asUser, repo, roomIds, cleanup } = require("./_db");
const { hashToken } = require("../../server/booking/state");

const R = repo();
let ROOM;
const guest = n => ({ name: "Test Guest " + n, email: `guest${n}${EMAIL_DOMAIN}`, phone: "+9198470" + String(10000 + n).slice(-5) });
const token = () => crypto.randomBytes(16).toString("hex");

async function hold(rooms, checkIn, checkOut, guests){
  const t = token();
  const res = await R.holdRooms({ hotelId: HOTEL, roomIds: rooms.map(n => ROOM[n]), guests: guests || rooms.map(() => 2),
                                  checkIn, checkOut, arrival: "14:00", departure: "12:00", tokenHash: hashToken(t) });
  return { res, t };
}
async function book(rooms, checkIn, checkOut, n = 1){
  const { res, t } = await hold(rooms, checkIn, checkOut);
  assert.equal(res.ok, true, JSON.stringify(res));
  const g = guest(n);
  const c = await R.confirmBooking({ ref: res.booking.booking_ref, tokenHash: hashToken(t), ...g, arrival: "14:00", departure: "11:00" });
  assert.equal(c.ok, true, JSON.stringify(c));
  return { ref: res.booking.booking_ref, t, booking: c.booking };
}
const free = async (a, b) => (await R.getAvailability(HOTEL, a, b)).filter(r => r.is_available).map(r => r.room_number);

test.before(async () => { await cleanup(); ROOM = await roomIds(); });
test.after(async () => {
  const removed = await cleanup();
  console.log("cleanup removed", JSON.stringify(removed));
});

test("availability: overlapping stays block, same-day turnover does not", async () => {
  await book([1], "2027-06-10", "2027-06-12");
  assert.ok(!(await free("2027-06-11", "2027-06-13")).includes(1), "overlap blocks");
  assert.ok(!(await free("2027-06-09", "2027-06-11")).includes(1), "overlap at the start blocks");
  assert.ok((await free("2027-06-12", "2027-06-14")).includes(1), "arrive the day the last guest leaves");
  assert.ok((await free("2027-06-08", "2027-06-10")).includes(1), "leave the day the next guest arrives");
  assert.equal((await free("2027-06-10", "2027-06-12")).length, 9);
});

test("a hold blocks only until it expires, then the room can be held again", async () => {
  const { res } = await hold([2], "2027-06-10", "2027-06-12");
  assert.equal(res.ok, true);
  assert.ok(!(await free("2027-06-10", "2027-06-12")).includes(2));
  const again = await hold([2], "2027-06-11", "2027-06-13");
  assert.equal(again.res.ok, false);
  assert.equal(again.res.reason, "unavailable");
  await withPg(c => c.query("update public.reservations set hold_expires_at = now() - interval '1 minute' where booking_ref = $1", [res.booking.booking_ref]));
  assert.ok((await free("2027-06-10", "2027-06-12")).includes(2), "an expired hold no longer blocks");
  const third = await hold([2], "2027-06-11", "2027-06-13");
  assert.equal(third.res.ok, true, "and the room can be held again");
});

test("prices: total = nightly rate × nights, per room, across types", async () => {
  const { res } = await hold([3, 8], "2027-06-15", "2027-06-18", [3, 1]);
  const b = res.booking;
  assert.equal(b.nights, 3);
  assert.deepEqual(b.rooms.map(r => [r.room_number, Number(r.price_per_night), Number(r.total_price)]), [[3, 2500, 7500], [8, 4500, 13500]]);
  assert.equal(Number(b.total_price), 21000);
  assert.equal(b.currency, "INR");
});

test("confirm: saves guest + booking, is idempotent, and needs the hold's token", async () => {
  const { res, t } = await hold([4], "2027-06-20", "2027-06-22");
  const ref = res.booking.booking_ref;
  assert.match(ref, /^MM-[A-Z2-9]{6}$/);
  const wrong = await R.confirmBooking({ ref, tokenHash: hashToken("not-the-token"), ...guest(4) });
  assert.deepEqual(wrong, { ok: false, reason: "not_found" });
  const first = await R.confirmBooking({ ref, tokenHash: hashToken(t), ...guest(4), arrival: "15:30" });
  assert.equal(first.ok, true);
  assert.equal(first.already, false);
  assert.equal(first.booking.status, "confirmed");
  assert.equal(first.booking.guest_email, `guest4${EMAIL_DOMAIN}`);
  assert.equal(first.booking.arrival_time, "15:30");
  const second = await R.confirmBooking({ ref, tokenHash: hashToken(t), ...guest(4) });
  assert.equal(second.already, true, "a second confirm returns the same booking");
  const rows = await withPg(c => c.query("select count(*)::int n from public.reservations where booking_ref = $1", [ref]));
  assert.equal(rows.rows[0].n, 1, "and creates nothing new");
  const g = await withPg(c => c.query("select count(*)::int n from public.guests where email = $1", [`guest4${EMAIL_DOMAIN}`]));
  assert.equal(g.rows[0].n, 1);
});

test("confirm after the hold lapsed: re-taken if still free, refused if someone else has it", async () => {
  const a = await hold([5], "2027-06-24", "2027-06-26");
  const expire = ref => withPg(c => c.query("update public.reservations set hold_expires_at = now() - interval '1 minute' where booking_ref = $1", [ref]));
  await expire(a.res.booking.booking_ref);
  const ok = await R.confirmBooking({ ref: a.res.booking.booking_ref, tokenHash: hashToken(a.t), ...guest(5) });
  assert.equal(ok.ok, true, "nobody took it, so it is booked");

  const b = await hold([6], "2027-06-24", "2027-06-26");
  await expire(b.res.booking.booking_ref);
  await book([6], "2027-06-25", "2027-06-27", 6);        // someone else books it meanwhile
  const lost = await R.confirmBooking({ ref: b.res.booking.booking_ref, tokenHash: hashToken(b.t), ...guest(66) });
  assert.deepEqual(lost, { ok: false, reason: "unavailable", rooms: [6] });
});

test("concurrency: ten simultaneous holds on one room — exactly one wins", async () => {
  const attempts = await Promise.all(Array.from({ length: 10 }, () => hold([7], "2027-06-03", "2027-06-05")));
  const wins = attempts.filter(a => a.res.ok);
  assert.equal(wins.length, 1, JSON.stringify(attempts.map(a => a.res.reason || "ok")));
  attempts.filter(a => !a.res.ok).forEach(a => assert.equal(a.res.reason, "unavailable"));
});

test("concurrency: overlapping multi-room holds never double-book any room", async () => {
  const sets = [[9, 10], [10, 9], [9], [10], [9, 10]];
  const attempts = await Promise.all(sets.map(s => hold(s, "2027-06-06", "2027-06-08", s.map(() => 1))));
  const rows = await withPg(c => c.query(`select r.room_number, count(*)::int n from public.reservations x join public.rooms r on r.id = x.room_id
                                           where x.check_in = '2027-06-06' and x.status = 'held' group by 1 order by 1`));
  rows.rows.forEach(r => assert.equal(r.n, 1, "room " + r.room_number + " held once"));
  assert.ok(attempts.some(a => a.res.ok));
});

test("the database itself refuses a double booking even without the functions", () => withPg(async c => {
  const existing = await c.query(`select room_id, check_in, check_out from public.reservations
                                   where status = 'confirmed' and check_in >= '2027-06-01' limit 1`);
  const r = existing.rows[0];
  await assert.rejects(c.query(`insert into public.reservations (booking_ref, hotel_id, room_id, check_in, check_out, num_guests, room_type,
                                  price_per_night, total_price, status, guest_id)
                                select 'MM-ZZZZZZ', $1, $2, $3, $4, 1, 'Normal', 100, 100 * ($4::date - $3::date), 'confirmed', guest_id
                                  from public.reservations where room_id = $2 and status = 'confirmed' limit 1`,
                               [HOTEL, r.room_id, r.check_in, r.check_out]), /no_double_booking|exclusion/);
}));

test("validation in the database: past dates, reversed dates, capacity, inactive rooms", async () => {
  assert.equal((await hold([1], "2026-01-01", "2026-01-03")).res.reason, "past_date");
  assert.equal((await hold([1], "2027-06-12", "2027-06-10")).res.reason, "invalid_dates");
  assert.equal((await hold([1], "2027-06-27", "2027-06-28", [4])).res.reason, "over_capacity");
  await withPg(c => c.query("update public.rooms set is_active = false where room_number = 2"));
  try {
    assert.ok(!(await free("2027-06-27", "2027-06-28")).includes(2), "inactive rooms are never offered");
    assert.equal((await hold([2], "2027-06-27", "2027-06-28")).res.reason, "unavailable");
  } finally {
    await withPg(c => c.query("update public.rooms set is_active = true where room_number = 2"));
  }
});

test("admin status changes: forward only; cancelling frees the room", async () => {
  const { ref } = await book([8], "2027-06-28", "2027-06-30", 8);
  const status = (claims, s) => asUser(claims, c => c.query("select public.admin_update_booking_status($1, $2, 'test') r", [ref, s]).then(x => x.rows[0].r));
  await assert.rejects(status({}, "cancelled"), /forbidden/);
  assert.equal((await status({ hotel_role: "admin" }, "checked_in")).reason, "invalid_transition", "can't check in before arrival day");
  assert.equal((await status({ hotel_role: "admin" }, "checked_out")).reason, "invalid_transition");
  // asUser rolls back, so commit the cancellation as an admin explicitly:
  await withPg(async c => {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", app_metadata: { hotel_role: "admin" } })]);
    const r = await c.query("select public.admin_update_booking_status($1, 'cancelled', 'test') r", [ref]);
    assert.equal(r.rows[0].r.ok, true);
    await c.query("commit");
  });
  assert.ok((await free("2027-06-28", "2027-06-30")).includes(8), "room 8 is free again");
});

test("admin report: revenue and room-nights from the reservations", () =>
  asUser({ hotel_role: "admin" }, async c => {
    const r = (await c.query("select public.admin_report($1, '2027-06-10', '2027-06-11') r", [HOTEL])).rows[0].r;
    const sold = await c.query(`select count(*)::int n, coalesce(sum(price_per_night),0)::numeric s
                                  from public.reservations x, generate_series(greatest(x.check_in,'2027-06-10'::date), least(x.check_out - 1,'2027-06-11'::date), '1 day') d
                                 where x.status in ('confirmed','checked_in','checked_out') and x.check_in <= '2027-06-11' and x.check_out > '2027-06-10'`);
    assert.equal(r.room_nights_sold, sold.rows[0].n);
    assert.equal(Number(r.room_revenue), Number(sold.rows[0].s));
    assert.equal(r.daily.length, 2);
    assert.equal(r.active_rooms, 10);
  }));

test("look-up needs the reference and a matching email or phone; holds are invisible", async () => {
  const { ref } = await book([1], "2027-06-14", "2027-06-16", 14);
  assert.equal((await R.findBooking(ref, `guest14${EMAIL_DOMAIN}`)).booking_ref, ref);
  assert.equal((await R.findBooking(ref.toLowerCase(), "+91 98470 10014")).booking_ref, ref);
  assert.equal(await R.findBooking(ref, "someone@else.test"), null);
  assert.equal(await R.findBooking(ref, "0014"), null, "a few digits are not enough");
  const { res } = await hold([10], "2027-06-14", "2027-06-16");
  assert.equal(await R.findBooking(res.booking.booking_ref, "anything@test.invalid"), null);
});

test("the ChatBot, end to end over HTTP, against the real database", async () => {
  // Supabase Auth is stubbed for one made-up token, so this test needs no
  // real account: it checks the HTTP path and that a signed-out guest can't
  // hold a room. The link from a booking to its account (reservations.user_id)
  // is checked against the database in tests/db/accounts.test.js.
  const TOKEN = "test-token-" + crypto.randomBytes(16).toString("hex");
  const repoModule = require("../../server/db/repository");
  const realCreate = repoModule.createRepository;
  repoModule.createRepository = (...args) => {
    const r = realCreate(...args);
    const realGetUser = r.getUser;
    r.getUser = async t => t === TOKEN ? { id: null, email: `http${EMAIL_DOMAIN}`, name: "Http Tester" } : realGetUser(t);
    return r;
  };
  const { handleRequest } = require("../../server/app");
  let state = null, auth = null;
  const turn = async body => {
    const headers = { "content-type": "application/json" };
    if (auth) headers.authorization = "Bearer " + auth;
    const r = await handleRequest({ method: "POST", headers,
                                    bodyText: JSON.stringify({ ...body, state }), clientIp: "db-test-" + Math.random() });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    if (r.body.state !== undefined) state = r.body.state;
    return r.body;
  };
  let out = await turn({ message: "Which hotels are available?" });
  assert.match(out.reply, /^Misty Mountain is currently the only hotel available on this platform/);
  out = await turn({ message: "How many rooms are available?" });
  assert.match(out.reply, /What date would you like to check in\?/);
  out = await turn({ message: "June 17, 2027" });
  out = await turn({ message: "2 PM" });
  out = await turn({ message: "June 19, 2027" });
  assert.match(out.reply, /How many guests will be staying, and how many rooms do you need\?/);
  out = await turn({ message: "2 guests, 1 room" });
  out = await turn({ message: "luxury" });
  assert.equal(out.ui.panel.type, "rooms");
  const pick = out.ui.panel.selected;
  out = await turn({ action: { type: "book", roomIds: pick } });
  assert.equal(out.error, "sign_in_required", "a signed-out guest is asked to sign in");
  assert.equal(out.ui.auth, true);
  const held = await withPg(c => c.query("select count(*)::int n from public.reservations where room_id = any($1) and check_in = '2027-06-17' and status = 'held'", [pick]));
  assert.equal(held.rows[0].n, 0, "and nothing is held");
  auth = TOKEN;
  out = await turn({ action: { type: "book", roomIds: pick } });
  assert.match(out.reply, /held for you/);
  assert.equal(out.ui.form.name, "Http Tester", "the guest form starts from the account");
  out = await turn({ action: { type: "guest", name: "Http Tester", phone: "98470 19999", email: `http${EMAIL_DOMAIN}` } });
  out = await turn({ action: { type: "confirm" } });
  assert.match(out.reply, /Your booking is confirmed! Your booking reference is MM-[A-Z2-9]{6}\./);
  const ref = out.data.bookingRef;
  const row = await withPg(c => c.query(`select x.status, x.total_price::text t, g.full_name from public.reservations x
                                          join public.guests g on g.id = x.guest_id where x.booking_ref = $1`, [ref]));
  assert.deepEqual(row.rows[0], { status: "confirmed", t: "9000.00", full_name: "Http Tester" });
});
